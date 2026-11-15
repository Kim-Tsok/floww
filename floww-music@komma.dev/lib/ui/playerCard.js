// The now-playing card: one component, hosted by the desktop widget, the
// top bar popover and the lock screen.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Spring, Ticker, Presets, clamp} from '../anim/spring.js';
import {AmbientBackground, ArtView, SwapLabel, Scrubber, Controls, bindState} from './widgets.js';
import {LyricsView, makeRefreshButton} from './lyricsView.js';
import {Visualizer} from './visualizer.js';

const VARIANTS = {
    widget: {width: 360, art: 64, radius: 12, lyricsHeight: 236, font: 21, anchor: 0.26},
    popover: {width: 400, art: 72, radius: 12, lyricsHeight: 300, font: 23, anchor: 0.28, visualizer: true},
    lock: {width: 460, art: 64, radius: 12, lyricsHeight: 132, font: 21, anchor: 0.22},
};

const VIZ_BARS_HEIGHT = 64;
const VIZ_AREA_HEIGHT = 112;

export const PlayerCard = GObject.registerClass({
    Signals: {'activate-lyrics': {}},
}, class FlowwMusicPlayerCard extends St.Widget {
    _init(state, settings, variant = 'widget') {
        const v = VARIANTS[variant];
        super._init({
            style_class: `flow-card flow-card-${variant}`,
            layout_manager: new Clutter.BinLayout(),
            width: v.width,
            reactive: true,
            track_hover: true,
        });
        this._state = state;

        this._bg = new AmbientBackground(state, {styleClass: 'flow-card-bg', dim: 0.92});
        this.add_child(this._bg);

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'flow-card-content',
            x_expand: true,
            y_expand: true,
        });
        this.add_child(content);

        // Header: art + titles
        const header = new St.BoxLayout({style_class: 'flow-card-header', x_expand: true});
        this._art = new ArtView(state, {size: v.art, radius: v.radius});
        header.add_child(this._art);
        const meta = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'flow-card-meta',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new SwapLabel({styleClass: 'flow-title'});
        this._artist = new SwapLabel({styleClass: 'flow-artist'});
        meta.add_child(this._title);
        meta.add_child(this._artist);
        header.add_child(meta);
        content.add_child(header);

        content.add_child(new Scrubber(state));
        content.add_child(new Controls(state, {extended: true, styleClass: 'flow-controls flow-controls-extended'}));

        // Lyrics area. In the expanded (popover) player it collapses to a
        // short visualizer when there are no lyrics to show.
        this._v = v;
        this._area = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            clip_to_allocation: true,
            height: v.lyricsHeight,
        });
        content.add_child(this._area);

        this._lyrics = new LyricsView(state, settings, {
            fontSize: v.font,
            anchor: v.anchor,
            styleClass: 'flow-lyrics flow-card-lyrics',
            fade: [0.14, 0.3],
        });
        this._lyrics.set_height(v.lyricsHeight);
        this._lyrics.y_align = Clutter.ActorAlign.START;
        this._lyrics.y_expand = false;
        this._area.add_child(this._lyrics);

        if (v.visualizer) {
            this._vizBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'flow-viz-box',
                x_expand: true,
                y_align: Clutter.ActorAlign.START,
                opacity: 0,
                visible: false,
            });
            this._viz = new Visualizer(state, settings, {height: VIZ_BARS_HEIGHT});
            this._vizBox.add_child(this._viz);
            const row = new St.BoxLayout({style_class: 'flow-viz-caption-row', x_align: Clutter.ActorAlign.CENTER});
            this._vizCaption = new St.Label({style_class: 'flow-viz-caption', y_align: Clutter.ActorAlign.CENTER});
            this._vizRefresh = makeRefreshButton(state, {size: 12});
            row.add_child(this._vizCaption);
            row.add_child(this._vizRefresh);
            this._vizBox.add_child(row);
            this._area.add_child(this._vizBox);

            this._mode = 'lyrics';
            this._height = new Spring(v.lyricsHeight, Presets.bouncy, 0.3);
            this._mix = new Spring(0, Presets.gentle, 0.002); // 0 lyrics, 1 visualizer
            this._ticker = new Ticker(this);
            this._ticker.add(dt => this._tickArea(dt));
            this.connect('destroy', () => this._ticker.destroy());
        }

        bindState(this, state, {
            'track': () => this._sync(true),
            'lyrics': () => this._syncMode(),
            'availability': () => this._syncMode(),
        });
        this._sync(false);
        this._syncMode(true);
    }

    _syncMode(instant = false) {
        if (!this._viz)
            return;
        const kind = this._state.lyrics.kind;
        if (kind === 'loading')
            return; // keep whatever is showing until we know
        const viz = ['none', 'offline', 'instrumental'].includes(kind) && this._state.available;
        if (viz) {
            this._vizCaption.text = {
                none: 'No lyrics for this song',
                offline: "Offline — lyrics will load when you're back",
                instrumental: 'Instrumental',
            }[kind];
            this._vizRefresh.visible = kind !== 'instrumental';
        }
        const mode = viz ? 'viz' : 'lyrics';
        if (mode === this._mode && !instant)
            return;
        this._mode = mode;
        this._height.target = viz ? VIZ_AREA_HEIGHT : this._v.lyricsHeight;
        this._mix.target = viz ? 1 : 0;
        if (instant) {
            this._height.jump(this._height.target);
            this._mix.jump(this._mix.target);
        }
        this._ticker.wake();
    }

    _tickArea(dt) {
        let moving = this._height.step(dt);
        if (this._mix.step(dt))
            moving = true;
        this._area.set_height(Math.round(Math.max(VIZ_AREA_HEIGHT * 0.8, this._height.value)));
        const m = clamp(this._mix.value, 0, 1);
        this._vizBox.opacity = Math.round(255 * m);
        this._vizBox.visible = m > 0.01;
        this._vizBox.translation_y = (1 - m) * 12;
        this._lyrics.opacity = Math.round(255 * (1 - m));
        this._lyrics.visible = m < 0.99;
        return moving;
    }

    get lyricsView() {
        return this._lyrics;
    }

    _sync(animate) {
        const t = this._state.track;
        this._title.setText(t?.title ?? 'Not playing', animate);
        this._artist.setText(t?.artist ?? 'Spotify', animate);
    }
});
