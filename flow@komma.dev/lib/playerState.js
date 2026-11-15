// Single source of truth shared by every Flow surface.
//
// Signals:
//   'availability'  Spotify appeared/vanished
//   'track'         new track metadata
//   'playback'      playing/paused
//   'seeked'        position jumped (seek, skip, resync)
//   'lyrics'        lyrics loaded/changed
//   'art'           album art + palette ready
//   'heartbeat'     once a second while playing

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {SpotifyMpris} from './mpris.js';
import {LyricsProvider} from './lyrics/provider.js';
import {fetchArt, extractPalette, DEFAULT_PALETTE} from './art.js';

const SYNC_INTERVAL_MS = 1000;
const HARD_RESYNC_US = 350_000;
const SOFT_RESYNC_US = 60_000;

// Smooth playback clock: interpolates between D-Bus position samples using
// the monotonic clock so lyrics move every frame without polling Spotify.
class PositionClock {
    constructor() {
        this._base = 0;
        this._t0 = GLib.get_monotonic_time();
        this._running = false;
    }

    get(at = GLib.get_monotonic_time()) {
        return this._running ? this._base + (at - this._t0) : this._base;
    }

    set(posUs, running = this._running) {
        this._base = posUs;
        this._t0 = GLib.get_monotonic_time();
        this._running = running;
    }

    setRunning(running) {
        if (running === this._running)
            return;
        this.set(this.get(), running);
    }

    // Returns true if this sample was a jump (seek) rather than drift.
    sync(sampleUs, sampledAt) {
        const diff = sampleUs - this.get(sampledAt);
        if (Math.abs(diff) > HARD_RESYNC_US) {
            this._base = sampleUs;
            this._t0 = sampledAt;
            return true;
        }
        if (Math.abs(diff) > SOFT_RESYNC_US)
            this._base += diff * 0.5;
        return false;
    }
}

export class PlayerState extends EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._clock = new PositionClock();
        this._lyricsProvider = new LyricsProvider(settings);
        this.track = null;
        this.lyrics = {kind: 'none'};
        this.art = {path: null, palette: DEFAULT_PALETTE};
        this.playing = false;
        this._trackCancellable = null;

        this._mpris = new SpotifyMpris();
        this._mpris.connect('appeared', () => this._onAppeared());
        this._mpris.connect('vanished', () => this._onVanished());
        this._mpris.connect('metadata', () => this._onMetadata());
        this._mpris.connect('status', () => this._onStatus());
        this._mpris.connect('seeked', (o, pos) => {
            this._clock.set(pos);
            this.emit('seeked');
        });
    }

    get available() {
        return this._mpris.available && this.track !== null;
    }

    get canSeek() {
        return this._mpris.canSeek;
    }

    // Current position in seconds, including the user's lyric offset.
    position() {
        return this._clock.get() / 1e6;
    }

    lyricTime() {
        return this.position() + this._settings.get_int('lyrics-offset-ms') / 1000;
    }

    get duration() {
        return (this.track?.length ?? 0) / 1e6;
    }

    playPause() {
        this._mpris.playPause();
    }

    next() {
        this._mpris.next();
    }

    previous() {
        this._mpris.previous();
    }

    seekTo(seconds) {
        if (!this.track)
            return;
        const us = Math.max(0, Math.min(seconds * 1e6, this.track.length - 1));
        this._clock.set(us); // optimistic; Spotify confirms via Seeked/resync
        this.emit('seeked');
        this._mpris.setPosition(this.track.trackPath, us);
    }

    _onAppeared() {
        this._onMetadata();
        this._onStatus();
        this._startSync();
    }

    _onVanished() {
        this._stopSync();
        this._trackCancellable?.cancel();
        this.track = null;
        this.playing = false;
        this._clock.set(0, false);
        this.emit('playback');
        this.emit('availability');
    }

    _onStatus() {
        const playing = this._mpris.playing;
        if (playing === this.playing)
            return;
        this.playing = playing;
        this._clock.setRunning(playing);
        this._resync();
        this.emit('playback');
    }

    _onMetadata() {
        const md = this._mpris.metadata;
        if (!md || !md.title) {
            if (this.track) {
                this.track = null;
                this.emit('availability');
            }
            return;
        }
        const wasAvailable = this.available;
        const prev = this.track;
        const changed = !prev || prev.id !== md.id || prev.title !== md.title;
        const artChanged = !prev || prev.artUrl !== md.artUrl;
        this.track = md;
        if (!wasAvailable)
            this.emit('availability');
        if (!changed) {
            if (artChanged)
                this._loadArt(md);
            if (prev.length !== md.length)
                this.emit('track');
            return;
        }
        this._clock.set(0);
        this._trackCancellable?.cancel();
        this._trackCancellable = new Gio.Cancellable();
        this.lyrics = {kind: 'loading'};
        this.emit('track');
        this.emit('lyrics');
        this.emit('seeked');
        this._loadArt(md);
        this._loadLyrics(md, this._trackCancellable);
        // Spotify updates position a beat after metadata.
        this._resyncSoon(250);
    }

    async _loadLyrics(track, cancellable) {
        if (track.isAd) {
            this.lyrics = {kind: 'none'};
            this.emit('lyrics');
            return;
        }
        try {
            const result = await this._lyricsProvider.get(track, cancellable);
            if (cancellable.is_cancelled() || this.track?.id !== track.id)
                return;
            this.lyrics = result;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            logError(e, 'Flow: lyrics');
            this.lyrics = {kind: 'none'};
        }
        this.emit('lyrics');
    }

    async _loadArt(track) {
        const cancellable = this._trackCancellable;
        try {
            const path = await fetchArt(track.artUrl, cancellable);
            if (cancellable?.is_cancelled() || this.track?.artUrl !== track.artUrl)
                return;
            this.art = {path, palette: path ? extractPalette(path) : DEFAULT_PALETTE};
            this.emit('art');
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Flow: art failed: ${e.message}`);
        }
    }

    _startSync() {
        this._stopSync();
        this._resync();
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_INTERVAL_MS, () => {
            if (this.playing) {
                this._resync();
                // Lets every animated surface re-check its frame ticker.
                this.emit('heartbeat');
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSync() {
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = 0;
        if (this._soonId)
            GLib.source_remove(this._soonId);
        this._soonId = 0;
    }

    _resyncSoon(ms) {
        if (this._soonId)
            GLib.source_remove(this._soonId);
        this._soonId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._soonId = 0;
            this._resync();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _resync() {
        if (this._syncing)
            return;
        this._syncing = true;
        try {
            const t0 = GLib.get_monotonic_time();
            const pos = await this._mpris.queryPosition();
            const t1 = GLib.get_monotonic_time();
            if (pos === null)
                return;
            // Assume the sample was taken halfway through the round-trip.
            if (this._clock.sync(pos, (t0 + t1) / 2))
                this.emit('seeked');
        } catch {
            // Spotify busy or gone; the next tick will try again.
        } finally {
            this._syncing = false;
        }
    }

    destroy() {
        this._stopSync();
        this._trackCancellable?.cancel();
        this._mpris.destroy();
        this.disconnectAll?.();
    }
}
