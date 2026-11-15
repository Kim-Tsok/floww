// MPRIS client: follows every media player on the session bus (Spotify,
// browsers, Rhythmbox, mpv, …) and exposes the one that matters right now.
// Emits plain JS signals, knows nothing about UI.
//
// Which player is "active":
//   • whichever started playing most recently;
//   • while nothing plays, the current one stays (pausing never steals focus);
//   • if it goes away, Spotify first, then the most recently heard one.
// With `player-source` = 'spotify', only Spotify is considered.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE_NAME = 'org.mpris.MediaPlayer2.Player';
// playerctld mirrors other players; following it would show everything twice.
const IGNORED = ['org.mpris.MediaPlayer2.playerctld'];
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

const PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/>
    <method name="Previous"/>
    <method name="PlayPause"/>
    <method name="OpenUri">
      <arg direction="in" type="s" name="Uri"/>
    </method>
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
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_IFACE);

function first(v) {
    return Array.isArray(v) ? v[0] : v;
}

function isSpotifyName(name) {
    return name.toLowerCase().includes('spotify');
}

// Signals: 'appeared', 'vanished', 'switched', 'metadata', 'status',
//          'seeked'(posUs), 'options'
export class MprisClient extends EventEmitter {
    constructor(settings = null) {
        super();
        this._settings = settings;
        this._players = new Map(); // busName → {proxy, ids, startedAt, seenAt}
        this._activeName = null;
        this._cancellable = new Gio.Cancellable();

        this._ownerId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE, (c, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });
        this._sourceId = settings?.connect('changed::player-source', () => this._rescan());
        this._rescan();
    }

    _wanted(name) {
        if (!name.startsWith(PREFIX) || IGNORED.includes(name))
            return false;
        const source = this._settings?.get_string('player-source') ?? 'any';
        return source !== 'spotify' || isSpotifyName(name);
    }

    _rescan() {
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE,
            -1, this._cancellable, (c, res) => {
                let names = [];
                try {
                    [names] = c.call_finish(res).deepUnpack();
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'Floww Music: could not list media players');
                    return;
                }
                for (const name of [...this._players.keys()]) {
                    if (!this._wanted(name))
                        this._removePlayer(name);
                }
                for (const name of names) {
                    if (this._wanted(name) && !this._players.has(name))
                        this._addPlayer(name);
                }
            });
    }

    async _addPlayer(name) {
        if (!this._wanted(name) || this._players.has(name))
            return;
        const entry = {proxy: null, ids: null, startedAt: 0, seenAt: GLib.get_monotonic_time()};
        this._players.set(name, entry);
        try {
            const proxy = await PlayerProxy.newAsync(Gio.DBus.session, name,
                OBJECT_PATH, this._cancellable);
            if (this._cancellable.is_cancelled() || this._players.get(name) !== entry)
                return;
            entry.proxy = proxy;
            if (proxy.PlaybackStatus === 'Playing')
                entry.startedAt = GLib.get_monotonic_time();
            const propsId = proxy.connect('g-properties-changed', (p, changed) => {
                const keys = Object.keys(changed.deepUnpack());
                if (keys.includes('PlaybackStatus')) {
                    const now = GLib.get_monotonic_time();
                    if (proxy.PlaybackStatus === 'Playing')
                        entry.startedAt = now;
                    entry.seenAt = now;
                    if (this._choose())
                        return; // a switch re-reads everything
                }
                if (name !== this._activeName)
                    return;
                if (keys.includes('Metadata'))
                    this.emit('metadata', this.metadata);
                if (keys.includes('PlaybackStatus'))
                    this.emit('status', this.playing);
                if (keys.includes('Shuffle') || keys.includes('LoopStatus'))
                    this.emit('options');
            });
            const seekedId = proxy.connectSignal('Seeked', (p, sender, [pos]) => {
                if (name === this._activeName)
                    this.emit('seeked', pos);
            });
            entry.ids = [propsId, seekedId];
            this._choose();
        } catch (e) {
            if (this._players.get(name) === entry)
                this._players.delete(name);
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Floww Music: could not connect to ${name}: ${e.message}`);
        }
    }

    _removePlayer(name) {
        const entry = this._players.get(name);
        if (!entry)
            return;
        this._players.delete(name);
        if (entry.proxy && entry.ids) {
            entry.proxy.disconnect(entry.ids[0]);
            entry.proxy.disconnectSignal(entry.ids[1]);
        }
        this._choose();
    }

    // Picks the active player. Returns true if it changed.
    _choose() {
        const ready = [...this._players].filter(([, e]) => e.proxy);
        const playing = ready.filter(([, e]) => e.proxy.PlaybackStatus === 'Playing')
            .sort((a, b) => b[1].startedAt - a[1].startedAt);
        let next = null;
        if (playing.length)
            next = playing[0][0];
        else if (this._activeName && this._players.get(this._activeName)?.proxy)
            next = this._activeName;
        else if (ready.length)
            next = (ready.find(([n]) => isSpotifyName(n)) ?? ready.sort((a, b) => b[1].seenAt - a[1].seenAt)[0])[0];

        if (next === this._activeName)
            return false;
        const prev = this._activeName;
        this._activeName = next;
        if (!prev)
            this.emit('appeared');
        else if (!next)
            this.emit('vanished');
        else
            this.emit('switched');
        return true;
    }

    get _proxy() {
        return this._players.get(this._activeName)?.proxy ?? null;
    }

    get available() {
        return this._proxy !== null;
    }

    get busName() {
        return this._activeName;
    }

    get isSpotify() {
        return !!this._activeName && isSpotifyName(this._activeName);
    }

    get playing() {
        return this._proxy?.PlaybackStatus === 'Playing';
    }

    // 'Playing' | 'Paused' | 'Stopped' | null
    get playbackStatus() {
        return this._proxy?.PlaybackStatus ?? null;
    }

    get hasShuffle() {
        return !!this._proxy?.get_cached_property('Shuffle');
    }

    get hasLoop() {
        return !!this._proxy?.get_cached_property('LoopStatus');
    }

    get shuffle() {
        return this._proxy?.get_cached_property('Shuffle')?.unpack() ?? false;
    }

    // 'None' | 'Track' | 'Playlist'
    get loopStatus() {
        return this._proxy?.get_cached_property('LoopStatus')?.unpack() ?? 'None';
    }

    _setProperty(name, variant) {
        if (!this._proxy)
            return;
        this._proxy.call('org.freedesktop.DBus.Properties.Set',
            new GLib.Variant('(ssv)', [PLAYER_IFACE_NAME, name, variant]),
            Gio.DBusCallFlags.NONE, 2000, this._cancellable, (p, r) => {
                try {
                    p.call_finish(r);
                } catch (e) {
                    console.debug(`Floww Music: could not set ${name}: ${e.message}`);
                }
            });
    }

    setShuffle(on) {
        this._setProperty('Shuffle', new GLib.Variant('b', on));
    }

    setLoopStatus(status) {
        this._setProperty('LoopStatus', new GLib.Variant('s', status));
    }

    openUri(uri) {
        this._proxy?.OpenUriAsync(uri).catch(e =>
            console.debug(`Floww Music: OpenUri failed: ${e.message}`));
    }

    get canSeek() {
        return this._proxy?.CanSeek ?? false;
    }

    get metadata() {
        const v = this._proxy?.get_cached_property('Metadata');
        if (!v)
            return null;
        const m = v.recursiveUnpack();
        let trackPath = String(m['mpris:trackid'] ?? '');
        if (trackPath === NO_TRACK)
            trackPath = '';
        const title = m['xesam:title'] ?? '';
        const artists = m['xesam:artist'];
        const artist = Array.isArray(artists) ? artists.join(', ') : String(artists ?? '');
        const url = m['xesam:url'] ?? '';
        const spotify = this.isSpotify;

        let id, isAd = false;
        if (spotify) {
            // Spotify: /com/spotify/track/<id>  (ads use /com/spotify/ad/…)
            const parts = trackPath.split('/');
            isAd = parts[parts.length - 2] === 'ad';
            id = parts[parts.length - 1] ?? '';
            if (!id && url.includes('/track/'))
                id = url.split('/track/')[1].split('?')[0];
        }
        // Others: by what's playing, so the lyrics cache works across players.
        id ||= `${title}|${first(artists) ?? ''}|${m['xesam:album'] ?? ''}`;
        return {
            busName: this._activeName,
            isSpotify: spotify,
            trackPath,
            id,
            isAd,
            title,
            artist,
            mainArtist: first(artists) ?? '',
            album: m['xesam:album'] ?? '',
            length: Number(m['mpris:length'] ?? 0), // µs
            artUrl: m['mpris:artUrl'] ?? '',
        };
    }

    // Live position in µs straight from the player (the cached property is stale).
    async queryPosition() {
        const proxy = this._proxy;
        if (!proxy)
            return null;
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
        Gio.DBus.session.signal_unsubscribe(this._ownerId);
        if (this._sourceId)
            this._settings.disconnect(this._sourceId);
        for (const name of [...this._players.keys()]) {
            const entry = this._players.get(name);
            this._players.delete(name);
            if (entry.proxy && entry.ids) {
                entry.proxy.disconnect(entry.ids[0]);
                entry.proxy.disconnectSignal(entry.ids[1]);
            }
        }
        this._activeName = null;
    }
}
