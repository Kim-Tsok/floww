// The now-playing card: one component, hosted by the desktop widget, the
// top bar popover and the lock screen.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {AmbientBackground, ArtView, SwapLabel, Scrubber, Controls, bindState} from './widgets.js';
import {LyricsView} from './lyricsView.js';

const VARIANTS = {
    widget: {width: 360, art: 64, radius: 12, lyricsHeight: 236, font: 21, anchor: 0.26},
    popover: {width: 400, art: 72, radius: 12, lyricsHeight: 300, font: 23, anchor: 0.28},
    lock: {width: 460, art: 64, radius: 12, lyricsHeight: 132, font: 21, anchor: 0.22},
};

export const PlayerCard = GObject.registerClass({
    Signals: {'activate-lyrics': {}},
}, class FlowPlayerCard extends St.Widget {
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
        content.add_child(new Controls(state));

        this._lyrics = new LyricsView(state, settings, {
            fontSize: v.font,
            anchor: v.anchor,
            styleClass: 'flow-lyrics flow-card-lyrics',
            fade: [0.14, 0.3],
        });
        this._lyrics.set_height(v.lyricsHeight);
        content.add_child(this._lyrics);

        bindState(this, state, {'track': () => this._sync(true)});
        this._sync(false);
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
