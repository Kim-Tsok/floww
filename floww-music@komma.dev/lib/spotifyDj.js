// Is Spotify's DJ the thing playing right now?
//
// MPRIS doesn't say what a track is playing *from*, so:
//   • with the sp_dc cookie stored (Spotify lyrics fallback), ask the web
//     player API for the playback context, once per track;
//   • otherwise remember that Floww started the DJ, until Spotify stops,
//     quits, or another player takes over.
// Everything fails soft: an error only means "keep the last answer".

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {getJson} from './http.js';
import {getToken} from './lyrics/spotify.js';

const CHECK_DELAY_MS = 800;

export class DjWatcher {
    constructor(djUri, onChange) {
        this._uri = djUri;
        this._onChange = onChange;
        this._started = false; // fallback: Floww started it
        this._api = null;      // null = API gave no answer
        this._cancellable = null;
        this._timerId = 0;
    }

    get active() {
        return this._api ?? this._started;
    }

    _set(fn) {
        const before = this.active;
        fn();
        if (this.active !== before)
            this._onChange();
    }

    markStarted() {
        this._set(() => {
            this._started = true;
            this._api = null; // the API's last answer is stale now
        });
        this.check();
    }

    // Spotify gone, stopped, or another player active.
    reset() {
        this._cancel();
        this._set(() => {
            this._started = false;
            this._api = null;
        });
    }

    _cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    // New track: ask again after Spotify has settled on it.
    check() {
        this._cancel();
        const cancellable = this._cancellable = new Gio.Cancellable();
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHECK_DELAY_MS, () => {
            this._timerId = 0;
            this._query(cancellable).catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
    }

    async _query(cancellable) {
        const token = await getToken(cancellable);
        if (!token || cancellable.is_cancelled())
            return;
        const {status, json} = await getJson('https://api.spotify.com/v1/me/player', {
            headers: {'Authorization': `Bearer ${token}`},
            cancellable,
            timeoutMs: 5000,
        });
        if (cancellable.is_cancelled() || status !== 200 || !json)
            return;
        const dj = json.context?.uri === this._uri;
        this._set(() => {
            this._api = dj;
            if (!dj)
                this._started = false; // the user moved on to something else
        });
    }

    destroy() {
        this._cancel();
        this._onChange = () => {};
    }
}
