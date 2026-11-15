// The music widget: Floww Music's player, rebuilt as a glass panel.
//   ┌──────────────────────────────────┐
//   │ [art]  Title                   ▮▮│
//   │        Artist                    │
//   │ ───────────●──────────           │
//   │   ⤮   ⏮   ⏯   ⏭   ↻   DJ         │
//   │  current lyric line…             │   (optional)
//   └──────────────────────────────────┘
// Everything comes from Floww Music's `api`, so it shares one Spotify
// connection, one lyrics cache and one clock with the rest of Floww.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Glass} from './glass.js';

export const WIDGET_WIDTH = 400;

export const MusicWidget = GObject.registerClass({
    Signals: {'activate': {}},
}, class FlowwLockMusicWidget extends Glass {
    _init(api, getBackdrop, settings) {
        super._init(getBackdrop, settings, {styleClass: 'floww-glass floww-music', reactive: true});
        this._api = api;
        this._settings = settings;
        this.width = WIDGET_WIDTH;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'floww-music-content',
        });

        const header = new St.BoxLayout({style_class: 'floww-music-header', x_expand: true});
        header.add_child(api.createArt({size: 58, radius: 12, pauseScale: 0.9, styleClass: 'flow-art floww-music-art'}));
        const meta = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'floww-music-meta',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = api.createSwapLabel({styleClass: 'floww-music-title'});
        this._artist = api.createSwapLabel({styleClass: 'floww-music-artist'});
        meta.add_child(this._title);
        meta.add_child(this._artist);
        header.add_child(meta);
        const eq = api.createEqBars();
        eq.y_align = Clutter.ActorAlign.START;
        header.add_child(eq);
        box.add_child(header);

        box.add_child(api.createScrubber());
        box.add_child(api.createControls({size: 18, playSize: 26, extended: true,
            styleClass: 'flow-controls flow-controls-extended floww-music-controls'}));

        this._lyrics = api.createLyricsView({
            fontSize: 19,
            anchor: 0.22,
            styleClass: 'flow-lyrics floww-music-lyrics',
            fade: [0.2, 0.35],
            maxBlur: 3,
            emptyAlign: 'center',
        });
        this._lyrics.set_height(96);
        this._lyrics.y_expand = false;
        box.add_child(this._lyrics);
        this.setChild(box);

        const state = api.state;
        const ids = [
            state.connect('track', () => this._sync(true)),
            state.connect('lyrics', () => this._syncLyrics()),
        ];
        const sid = settings.connect('changed::widget-lyrics', () => this._syncLyrics());
        this.connect('destroy', () => {
            ids.forEach(id => state.disconnect(id));
            settings.disconnect(sid);
        });

        // Click anywhere but a control → immersive lyrics.
        const click = new Clutter.ClickGesture();
        click.connect('may-recognize', () => !this._pointerOnControl());
        click.connect('recognize', () => this.emit('activate'));
        this.add_action(click);

        this._sync(false);
        this._syncLyrics();
    }

    _pointerOnControl() {
        const [x, y] = global.get_pointer();
        let a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (a && a !== this) {
            if (a instanceof St.Button || a.has_style_class_name?.('flow-scrubber-hit'))
                return true;
            a = a.get_parent();
        }
        return false;
    }

    _sync(animate) {
        const t = this._api.state.track;
        this._title.setText(t?.title ?? '', animate);
        this._artist.setText(t?.artist ?? '', animate);
    }

    _syncLyrics() {
        const kind = this._api.state.lyrics.kind;
        // Only spend room on lyrics when there are lines to show.
        this._lyrics.visible = this._settings.get_boolean('widget-lyrics') &&
            (kind === 'synced' || kind === 'plain' || kind === 'loading');
    }
});
