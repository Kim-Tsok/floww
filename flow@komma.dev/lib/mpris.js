// Thin MPRIS client for Spotify. Emits plain JS signals, knows nothing about UI.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'org.mpris.MediaPlayer2.spotify';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE_NAME = 'org.mpris.MediaPlayer2.Player';

const PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_IFACE);

function first(v) {
    return Array.isArray(v) ? v[0] : v;
}

// Signals: 'appeared', 'vanished', 'metadata', 'status', 'seeked'(posUs)
export class SpotifyMpris extends EventEmitter {
    constructor() {
        super();
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onAppeared(),
            () => this._onVanished());
    }

    get available() {
        return this._proxy !== null;
    }

    async _onAppeared() {
        try {
            const proxy = await PlayerProxy.newAsync(Gio.DBus.session, BUS_NAME,
                OBJECT_PATH, this._cancellable);
            if (this._cancellable.is_cancelled())
                return;
            this._proxy = proxy;
            this._propsId = proxy.connect('g-properties-changed', (p, changed) => {
                const keys = Object.keys(changed.deepUnpack());
                if (keys.includes('Metadata'))
                    this.emit('metadata', this.metadata);
                if (keys.includes('PlaybackStatus'))
                    this.emit('status', this.playing);
            });
            this._seekedId = proxy.connectSignal('Seeked', (p, sender, [pos]) => {
                this.emit('seeked', pos);
            });
            this.emit('appeared');
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Flow: could not connect to Spotify');
        }
    }

    _onVanished() {
        if (!this._proxy)
            return;
        this._dropProxy();
        this.emit('vanished');
    }

    _dropProxy() {
        if (!this._proxy)
            return;
        this._proxy.disconnect(this._propsId);
        this._proxy.disconnectSignal(this._seekedId);
        this._proxy = null;
    }

    get playing() {
        return this._proxy?.PlaybackStatus === 'Playing';
    }

    get canSeek() {
        return this._proxy?.CanSeek ?? false;
    }

    get metadata() {
        const v = this._proxy?.get_cached_property('Metadata');
        if (!v)
            return null;
        const m = v.recursiveUnpack();
        const trackPath = m['mpris:trackid'] ?? '';
        // Spotify: /com/spotify/track/<id>  (ads use /com/spotify/ad/…)
        const parts = String(trackPath).split('/');
        const kind = parts[parts.length - 2] ?? '';
        let spotifyId = parts[parts.length - 1] ?? '';
        const url = m['xesam:url'] ?? '';
        if (!spotifyId && url.includes('/track/'))
            spotifyId = url.split('/track/')[1].split('?')[0];
        return {
            trackPath: String(trackPath),
            id: spotifyId || `${m['xesam:title']}-${first(m['xesam:artist'])}`,
            isAd: kind === 'ad',
            title: m['xesam:title'] ?? '',
            artist: (m['xesam:artist'] ?? []).join?.(', ') ?? String(m['xesam:artist'] ?? ''),
            mainArtist: first(m['xesam:artist']) ?? '',
            album: m['xesam:album'] ?? '',
            length: Number(m['mpris:length'] ?? 0), // µs
            artUrl: m['mpris:artUrl'] ?? '',
        };
    }

    // Live position in µs straight from Spotify (the cached property is stale).
    async queryPosition() {
        if (!this._proxy)
            return null;
        const proxy = this._proxy;
        const res = await new Promise((resolve, reject) => {
            proxy.call('org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE_NAME, 'Position']),
                Gio.DBusCallFlags.NONE, 1000, this._cancellable,
                (p, r) => {
                    try {
                        resolve(p.call_finish(r));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        return Number(res.recursiveUnpack()[0]);
    }

    playPause() {
        this._proxy?.PlayPauseAsync().catch(() => {});
    }

    next() {
        this._proxy?.NextAsync().catch(() => {});
    }

    previous() {
        this._proxy?.PreviousAsync().catch(() => {});
    }

    setPosition(trackPath, posUs) {
        if (!this._proxy || !trackPath)
            return;
        this._proxy.SetPositionAsync(trackPath, Math.max(0, Math.round(posUs))).catch(() => {});
    }

    destroy() {
        this._cancellable.cancel();
        Gio.bus_unwatch_name(this._watchId);
        this._dropProxy();
    }
}
