// Adaptive top bar pill — a "Dynamic Island" for Spotify.
//
// Rest: tiny art + equalizer bars. When a lyric line starts it springs wider
// and the line slides in; long silences collapse it again. Hover reveals the
// title. Click opens the full player card as a popover.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Spring, Ticker, Presets} from '../anim/spring.js';
import {lineIndexAt} from '../lyrics/lrc.js';
import {ArtView, EqBars, bindState} from './widgets.js';
import {PlayerCard} from './playerCard.js';

const MAX_TEXT_WIDTH = 380;
const COLLAPSE_AFTER = 1.2;  // seconds of an interlude before collapsing

const PillText = GObject.registerClass(
class FlowPillText extends St.Widget {
    _init() {
        super._init({clip_to_allocation: true, y_expand: true, layout_manager: new Clutter.BinLayout()});
        this._label = null;
        this._text = '';
    }

    get text() {
        return this._text;
    }

    _make(text) {
        const l = new St.Label({
            style_class: 'flow-pill-text',
            text,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0, y: 0.5}),
        });
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return l;
    }

    // Natural width of `text` (capped) so the pill can spring to it.
    measure(text) {
        const l = this._make(text);
        this.add_child(l);
        const [, w] = l.get_preferred_width(-1);
        l.destroy();
        return Math.min(MAX_TEXT_WIDTH, Math.ceil(w));
    }

    setText(text, direction = 1) {
        if (text === this._text)
            return;
        this._text = text;
        const old = this._label;
        if (old) {
            old.remove_all_transitions();
            old.ease({
                opacity: 0,
                translation_y: -8 * direction,
                scale_x: 0.96, scale_y: 0.96,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => old.destroy(),
            });
        }
        if (!text) {
            this._label = null;
            return;
        }
        const l = this._make(text);
        l.opacity = 0;
        l.translation_y = 9 * direction;
        this.add_child(l);
        l.set_width(Math.min(MAX_TEXT_WIDTH, l.get_preferred_width(-1)[1]));
        this._label = l;
        l.ease({opacity: 255, translation_y: 0, duration: 420, delay: 70,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT});
    }
});

export const FlowIndicator = GObject.registerClass(
class FlowIndicator extends PanelMenu.Button {
    _init(state, settings) {
        super._init(0.5, 'Flow', false);
        this._state = state;
        this._settings = settings;
        this.add_style_class_name('flow-panel-button');

        this._pill = new St.BoxLayout({
            style_class: 'flow-pill',
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._art = new ArtView(state, {size: 18, radius: 5, pauseScale: 0.82, styleClass: 'flow-pill-art'});
        this._eq = new EqBars(state);
        this._text = new PillText();
        this._text.set_width(0);
        this._pill.add_child(this._art);
        this._pill.add_child(this._eq);
        this._pill.add_child(this._text);
        this.add_child(this._pill);

        this._width = new Spring(0, Presets.bouncy, 0.3);
        this._hoverScale = new Spring(1, Presets.snappy);
        this._lineIdx = -2;
        this._ticker = new Ticker(this);
        this._ticker.add((dt, now) => this._tick(dt, now));

        // Popover with the full card.
        this.menu.actor.add_style_class_name('flow-menu');
        this._card = new PlayerCard(state, settings, 'popover');
        this.menu.box.add_child(this._card);

        this.connect('notify::hover', () => {
            this._hoverScale.target = this.hover ? 1.04 : 1;
            this._ticker.wake();
        });
        this._settingsId = settings.connect('changed::panel-lyrics', () => this._ticker.wake());

        bindState(this, state, {
            'availability': () => this._syncVisible(),
            'track': () => {
                this._lineIdx = -2;
                this._ticker.wake();
            },
            'lyrics': () => {
                this._lineIdx = -2;
                this._ticker.wake();
            },
            'seeked': () => this._ticker.wake(),
            'playback': () => this._ticker.wake(),
            'heartbeat': () => this._ticker.wake(),
        });
        this.connect('destroy', () => {
            settings.disconnect(this._settingsId);
            this._ticker.destroy();
        });
        this._syncVisible(true);
    }

    _syncVisible(instant = false) {
        const show = this._state.available;
        // Animate the whole button container so the panel reflows smoothly.
        const container = this.container ?? this;
        if (show) {
            container.show();
            if (instant) {
                this._pill.opacity = 255;
                this._pill.set_scale(1, 1);
            } else {
                this._pill.set_scale(0.6, 0.6);
                this._pill.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 500,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK});
            }
            this._ticker.wake();
        } else if (instant) {
            container.hide();
        } else {
            this.menu.close();
            this._pill.ease({opacity: 0, scale_x: 0.6, scale_y: 0.6, duration: 260,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => {
                    if (!this._state.available)
                        container.hide();
                }});
        }
    }

    // What the pill should say right now ('' = compact).
    _desiredText(t) {
        const st = this._state;
        if (this.hover && st.track)
            return {text: `${st.track.title} · ${st.track.artist}`, key: 'hover'};
        if (!this._settings.get_boolean('panel-lyrics') || st.lyrics.kind !== 'synced')
            return {text: '', key: 'none'};
        const lines = st.lyrics.lines;
        const idx = lineIndexAt(lines, t + 0.1);
        const line = lines[idx];
        if (!line)
            return {text: '', key: 'none'};
        if (line.interlude && t - line.start > COLLAPSE_AFTER)
            return {text: '', key: `i${idx}`, idx};
        if (line.interlude)
            return {text: this._text.text, key: `i${idx}`, idx}; // keep briefly
        return {text: line.text, key: `l${idx}`, idx};
    }

    _tick(dt) {
        const st = this._state;
        const {text, key, idx} = this._desiredText(st.lyricTime());
        if (key !== this._key) {
            const dir = idx !== undefined && idx < this._lineIdx ? -1 : 1;
            this._key = key;
            if (idx !== undefined)
                this._lineIdx = idx;
            this._text.setText(text, dir);
            this._width.target = text ? this._text.measure(text) + 4 : 0;
        }
        let moving = this._width.step(dt);
        const w = Math.max(0, this._width.value);
        this._text.set_width(Math.round(w));
        this._text.visible = w > 0.5;
        if (this._hoverScale.step(dt))
            moving = true;
        this._pill.set_scale(this._hoverScale.value, this._hoverScale.value);
        // Keep ticking while playing (lyric lines advance with time).
        return moving || (st.playing && st.lyrics.kind === 'synced');
    }
});

export function addIndicator(uuid, state, settings) {
    const indicator = new FlowIndicator(state, settings);
    const pos = settings.get_string('panel-position');
    const index = pos === 'left' ? 1 : 0;
    Main.panel.addToStatusArea(uuid, indicator, index, pos);
    return indicator;
}
