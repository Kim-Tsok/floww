// Single source of truth shared by every Flow surface.
//
// Signals:
//   'availability'  a player appeared/vanished (or the active one changed)
//   'track'         new track metadata
//   'playback'      playing/paused
//   'seeked'        position jumped (seek, skip, resync)
//   'lyrics'        lyrics loaded/changed
//   'art'           album art + palette ready
//   'heartbeat'     once a second while playing
//   'options'       shuffle / repeat changed
//   'dj'            Spotify's DJ started or stopped (see `djActive`)

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {MprisClient} from './mpris.js';
import {DjWatcher} from './spotifyDj.js';
import {LyricsProvider, isOffline} from './lyrics/provider.js';
import {fetchArt, cachedArt, artSteps, extractPalette, DEFAULT_PALETTE} from './art.js';

const SYNC_INTERVAL_MS = 1000;
const HARD_RESYNC_US = 350_000;
const SOFT_RESYNC_US = 60_000;
const LOOP_ORDER = ['None', 'Playlist', 'Track'];
// Spotify's DJ lives behind this playlist URI; opening it starts the DJ on
// accounts that have it.
const DJ_URI = 'spotify:playlist:37i9dQZF1EYkqdzj48dyYq';

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
        this._artCancellable = null;
        this._pendingOptions = {};

        this._dj = new DjWatcher(DJ_URI, () => this.emit('dj'));
        this._mpris = new MprisClient(settings);
        this._mpris.connect('appeared', () => this._onAppeared());
        this._mpris.connect('vanished', () => this._onVanished());
        this._mpris.connect('switched', () => this._onSwitched());
        this._mpris.connect('metadata', () => this._onMetadata());
        this._mpris.connect('status', () => this._onStatus());
        this._mpris.connect('seeked', (o, pos) => {
            this._clock.set(pos);
            this.emit('seeked');
        });
        this._mpris.connect('options', () => {
            this._pendingOptions = {};
            this.emit('options');
        });

        // Lyrics that failed for lack of network come back on their own.
        this._netMonitor = Gio.NetworkMonitor.get_default();
        this._netId = this._netMonitor.connect('network-changed', () => this._onNetworkChanged());
    }

    _onNetworkChanged() {
        if (this.lyrics.kind !== 'offline' || isOffline())
            return;
        // Debounce: interfaces flap while a connection comes up.
        if (this._netRetryId)
            GLib.source_remove(this._netRetryId);
        this._netRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._netRetryId = 0;
            if (this.lyrics.kind === 'offline')
                this.reloadLyrics();
            if (this.track && !this.art.path)
                this._loadArt(this.track);
            return GLib.SOURCE_REMOVE;
        });
    }

    get available() {
        return this._mpris.available && this.track !== null;
    }

    get canSeek() {
        return this._mpris.canSeek;
    }

    // The active player is Spotify (DJ, ads, Spotify lyrics apply).
    get isSpotify() {
        return this._mpris.isSpotify;
    }

    get hasShuffle() {
        return this._mpris.hasShuffle;
    }

    get hasLoop() {
        return this._mpris.hasLoop;
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

    // Shuffle / repeat: applied optimistically, then confirmed by Spotify.
    get shuffle() {
        return this._pendingOptions.shuffle ?? this._mpris.shuffle;
    }

    get loop() {
        return this._pendingOptions.loop ?? this._mpris.loopStatus;
    }

    toggleShuffle() {
        const on = !this.shuffle;
        this._pendingOptions.shuffle = on;
        this._mpris.setShuffle(on);
        this.emit('options');
    }

    cycleLoop() {
        const next = LOOP_ORDER[(LOOP_ORDER.indexOf(this.loop) + 1) % LOOP_ORDER.length];
        this._pendingOptions.loop = next;
        this._mpris.setLoopStatus(next);
        this.emit('options');
    }

    // Spotify's DJ is what's playing (best effort, see spotifyDj.js).
    get djActive() {
        return this._mpris.isSpotify && this._dj.active;
    }

    // Starts the DJ, or, when it's already on, asks it for a new set
    // (what Spotify's own DJ button does).
    startDJ() {
        if (!this._mpris.isSpotify)
            return;
        this._mpris.openUri(DJ_URI);
        this._dj.markStarted();
    }

    // Manual "try again" from the UI (also used after reconnecting).
    reloadLyrics() {
        const track = this.track;
        if (!track || this.lyrics.kind === 'loading')
            return;
        this._trackCancellable?.cancel();
        this._trackCancellable = new Gio.Cancellable();
        this.lyrics = {kind: 'loading'};
        this.emit('lyrics');
        this._loadLyrics(track, this._trackCancellable, true);
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

    // Another player took over: re-read everything from it.
    _onSwitched() {
        this._pendingOptions = {};
        this._dj.reset();
        this._onMetadata();
        this._onStatus();
        this.emit('options');
        this.emit('availability');
        this._resync();
    }

    _onVanished() {
        this._stopSync();
        this._dj.reset();
        this._trackCancellable?.cancel();
        this._artCancellable?.cancel();
        this.track = null;
        this.playing = false;
        this._clock.set(0, false);
        this.emit('playback');
        this.emit('availability');
    }

    _onStatus() {
        if (this._mpris.playbackStatus === 'Stopped')
            this._dj.reset();
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
        if (artChanged)
            this._loadArt(md);
        this._loadLyrics(md, this._trackCancellable);
        if (md.isSpotify)
            this._dj.check();
        // Players update the position a beat after metadata.
        this._resyncSoon(250);
    }

    async _loadLyrics(track, cancellable, force = false) {
        if (track.isAd) {
            this.lyrics = {kind: 'none'};
            this.emit('lyrics');
            return;
        }
        try {
            const result = await this._lyricsProvider.get(track, cancellable, {force});
            if (cancellable.is_cancelled() || this.track?.id !== track.id)
                return;
            this.lyrics = result;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            logError(e, 'Floww Music: lyrics');
            this.lyrics = {kind: 'none'};
        }
        this.emit('lyrics');
    }

    _setArt(path, palette) {
        this.art = {path, palette: palette ?? (path ? extractPalette(path) : this.art.palette)};
        this.emit('art');
    }

    // Shows the new cover as soon as anything is available: a cached copy
    // instantly, else a tiny thumbnail, then the full size. Never leaves the
    // previous song's cover up while we wait.
    async _loadArt(track) {
        this._artCancellable?.cancel();
        const cancellable = this._artCancellable = new Gio.Cancellable();
        const url = track.artUrl;
        const current = () => !cancellable.is_cancelled() && this.track?.artUrl === url;

        const cached = cachedArt(url);
        if (cached)
            this._setArt(cached);
        else if (this.art.path)
            this._setArt(null, this.art.palette); // placeholder, keep colours

        const steps = artSteps(url);
        const full = steps[steps.length - 1];
        if (!full)
            return;
        for (const step of steps) {
            if (cached && step !== full)
                continue; // already showing something at least this good
            try {
                // eslint-disable-next-line no-await-in-loop
                const path = await fetchArt(step, cancellable);
                if (!current())
                    return;
                if (path && path !== this.art.path)
                    this._setArt(path);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                console.debug(`Floww Music: art failed: ${e.message}`);
            }
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
        this._netMonitor.disconnect(this._netId);
        if (this._netRetryId)
            GLib.source_remove(this._netRetryId);
        this._trackCancellable?.cancel();
        this._artCancellable?.cancel();
        this._dj.destroy();
        this._mpris.destroy();
        this.disconnectAll?.();
    }
}
