// Lyrics lookup with memory + disk cache and source fallback.
// Result shapes:
//   {kind: 'synced', lines, source}
//   {kind: 'plain', plain: [string], source}
//   {kind: 'instrumental'} | {kind: 'none'}

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {fetchLrclib} from './lrclib.js';
import {fetchSpotify} from './spotify.js';

const CACHE_VERSION = 2;
const NONE_RETRY_SECONDS = 24 * 3600;
const MEMORY_MAX = 40;

function cacheDir() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'flow', 'lyrics']);
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
}

function cacheFile(track) {
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1,
        `${track.id}|${track.title}|${track.artist}`, -1);
    return Gio.File.new_for_path(GLib.build_filenamev([cacheDir(), `${key}.json`]));
}

export class LyricsProvider {
    constructor(settings) {
        this._settings = settings;
        this._memory = new Map();
    }

    async _readDisk(track) {
        try {
            const bytes = await new Promise((resolve, reject) => {
                cacheFile(track).load_contents_async(null, (f, res) => {
                    try {
                        resolve(f.load_contents_finish(res)[1]);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (data.v !== CACHE_VERSION)
                return null;
            if (data.result.kind === 'none' && Date.now() / 1000 - data.at > NONE_RETRY_SECONDS)
                return null;
            return data.result;
        } catch {
            return null;
        }
    }

    _writeDisk(track, result) {
        const json = JSON.stringify({v: CACHE_VERSION, at: Math.floor(Date.now() / 1000), result});
        cacheFile(track).replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(json)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                } catch (e) {
                    console.debug(`Flow: could not cache lyrics: ${e.message}`);
                }
            });
    }

    _remember(track, result) {
        this._memory.set(track.id, result);
        if (this._memory.size > MEMORY_MAX)
            this._memory.delete(this._memory.keys().next().value);
    }

    async get(track, cancellable) {
        if (this._memory.has(track.id))
            return this._memory.get(track.id);

        const disk = await this._readDisk(track);
        if (disk) {
            this._remember(track, disk);
            return disk;
        }

        let result = null;
        let networkFailed = false;
        try {
            result = await fetchLrclib(track, cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            networkFailed = true;
            console.debug(`Flow: LRCLIB failed: ${e.message}`);
        }

        if (result?.kind !== 'synced' && this._settings.get_boolean('spotify-fallback')) {
            const sp = await fetchSpotify(track, cancellable);
            if (sp && (sp.kind === 'synced' || !result))
                result = sp;
        }

        result ??= {kind: 'none'};
        this._remember(track, result);
        // Don't persist "none" caused by a network failure — retry next time.
        if (!(networkFailed && result.kind === 'none'))
            this._writeDisk(track, result);
        return result;
    }
}
