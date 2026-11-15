// Lyrics lookup with memory + disk cache and source fallback.
// Result shapes:
//   {kind: 'synced', lines, source}
//   {kind: 'plain', plain: [string], source}
//   {kind: 'instrumental'} | {kind: 'none'}
//   {kind: 'offline'}   network down or too slow; never cached, retried later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {fetchLrclib} from './lrclib.js';
import {fetchSpotify} from './spotify.js';

const CACHE_VERSION = 2;
const NONE_RETRY_SECONDS = 24 * 3600;
const MEMORY_MAX = 40;
const LOOKUP_BUDGET_MS = 8000; // whole lookup, every source included

// True when there is clearly no route to the internet. NetworkMonitor is
// cheap and local, so a fully offline machine answers instantly.
export function isOffline() {
    try {
        const mon = Gio.NetworkMonitor.get_default();
        if (!mon.network_available)
            return true;
        const c = mon.connectivity;
        return c === Gio.NetworkConnectivity.LOCAL;
    } catch {
        return false;
    }
}

function isCancelled(e) {
    return e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function cacheDir() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'floww', 'lyrics']);
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
                    console.debug(`Floww Music: could not cache lyrics: ${e.message}`);
                }
            });
    }

    _remember(track, result) {
        this._memory.set(track.id, result);
        if (this._memory.size > MEMORY_MAX)
            this._memory.delete(this._memory.keys().next().value);
    }

    // force: skip the memory cache and any cached "none" (manual refresh).
    async get(track, cancellable, {force = false} = {}) {
        if (!force && this._memory.has(track.id))
            return this._memory.get(track.id);

        const disk = await this._readDisk(track);
        if (disk && !(force && disk.kind === 'none')) {
            this._remember(track, disk);
            return disk;
        }

        if (isOffline())
            return {kind: 'offline'};

        // One budget for the whole lookup: cancel everything when it runs out.
        const budget = new Gio.Cancellable();
        // Gio.Cancellable.connect = g_cancellable_connect (fires at once if
        // already cancelled).
        const parentId = cancellable.connect(() => budget.cancel());
        let expired = false;
        let timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOOKUP_BUDGET_MS, () => {
            timerId = 0;
            expired = true;
            budget.cancel();
            return GLib.SOURCE_REMOVE;
        });

        let result = null;
        let networkFailed = false;
        try {
            try {
                result = await fetchLrclib(track, budget);
            } catch (e) {
                if (isCancelled(e) && !expired)
                    throw e;
                networkFailed = true;
                console.debug(`Floww Music: LRCLIB failed: ${e.message}`);
            }

            if (!expired && track.isSpotify && result?.kind !== 'synced' && this._settings.get_boolean('spotify-fallback')) {
                const sp = await fetchSpotify(track, budget);
                if (sp && (sp.kind === 'synced' || !result))
                    result = sp;
            }
        } finally {
            if (timerId)
                GLib.source_remove(timerId);
            cancellable.disconnect(parentId);
        }
        if (cancellable.is_cancelled())
            throw new Gio.IOErrorEnum({code: Gio.IOErrorEnum.CANCELLED, message: 'cancelled'});

        if (!result && (networkFailed || expired))
            return {kind: 'offline'}; // not remembered: retry next time
        result ??= {kind: 'none'};
        this._remember(track, result);
        this._writeDisk(track, result);
        return result;
    }
}
