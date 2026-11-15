// Reusable building blocks shared by every surface.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Spring, Ticker, Presets, lerp, easeInOutCubic, clamp} from '../anim/spring.js';
import {AmbientEffect} from './effects.js';

export function formatTime(s) {
    s = Math.max(0, Math.floor(s));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function artStyle(path, radius) {
    const uri = GLib.filename_to_uri(path, null).replace(/"/g, '\\"');
    return `background-image: url("${uri}"); background-size: cover; border-radius: ${radius}px;`;
}

// Disconnects every handler on destroy; avoids leaks across the many
// short-lived widgets that listen to the shared PlayerState.
export function bindState(widget, state, handlers) {
    const ids = Object.entries(handlers).map(([sig, fn]) => state.connect(sig, fn));
    widget.connect('destroy', () => ids.forEach(id => state.disconnect(id)));
}

// ── Ambient background ──────────────────────────────────────────────────
export const AmbientBackground = GObject.registerClass(
class FlowwMusicAmbientBackground extends St.Widget {
    _init(state, {styleClass = 'flow-ambient', dim = 1.0} = {}) {
        super._init({style_class: styleClass, x_expand: true, y_expand: true});
        this._state = state;
        this._effect = new AmbientEffect();
        this.add_effect(this._effect);
        this._effect.setDim(dim);
        this._time = Math.random() * 100;
        this._from = state.art.palette;
        this._to = state.art.palette;
        this._mix = 1;
        this._effect.setColors(this._to);

        this._ticker = new Ticker(this);
        this._ticker.add(dt => this._tick(dt));
        this.connect('notify::allocation', () => {
            const [w, h] = this.get_size();
            if (w > 0 && h > 0)
                this._effect.setAspect(w / h);
        });
        bindState(this, state, {
            'art': () => this._setPalette(state.art.palette),
            'playback': () => this._ticker.wake(),
            'heartbeat': () => this._ticker.wake(),
        });
        this.connect('destroy', () => this._ticker.destroy());
    }

    _setPalette(palette) {
        if (!this.mapped) {
            // Nobody is watching: no need to animate the change.
            this._from = this._to = palette;
            this._mix = 1;
            this._effect.setColors(palette);
            return;
        }
        this._from = this._current();
        this._to = palette;
        this._mix = 0;
        this._ticker.wake();
    }

    _current() {
        const e = easeInOutCubic(this._mix);
        return this._to.map((c, i) => c.map((v, j) => lerp(this._from[i][j], v, e)));
    }

    _tick(dt) {
        const transitioning = this._mix < 1;
        if (transitioning) {
            this._mix = Math.min(1, this._mix + dt / 1.4);
            this._effect.setColors(this._current());
        }
        if (this._state.playing) {
            this._time += dt * 0.6;
            this._effect.setTime(this._time);
        }
        return transitioning || this._state.playing;
    }
});

// ── Album art with cross-fade + play/pause "breathing" scale ────────────
export const ArtView = GObject.registerClass(
class FlowwMusicArtView extends St.Widget {
    _init(state, {size = 64, radius = 10, pauseScale = 0.86, styleClass = 'flow-art'} = {}) {
        super._init({
            style_class: styleClass,
            width: size,
            height: size,
            x_expand: false,
            y_expand: false,
            layout_manager: new Clutter.BinLayout(),
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._state = state;
        this._radius = radius;
        this._layer = null;
        this._scale = new Spring(state.playing ? 1 : pauseScale, Presets.bouncy);
        this._pauseScale = pauseScale;
        this.set_scale(this._scale.value, this._scale.value);
        this._ticker = new Ticker(this);
        this._ticker.add(dt => {
            const moving = this._scale.step(dt);
            this.set_scale(this._scale.value, this._scale.value);
            return moving;
        });
        bindState(this, state, {
            'art': () => this._show(state.art.path),
            'playback': () => {
                this._scale.target = state.playing ? 1 : this._pauseScale;
                this._ticker.wake();
            },
        });
        this.connect('destroy', () => this._ticker.destroy());
        this._show(state.art.path, true);
    }

    _show(path, instant = false) {
        if (this._layer && path === this._path)
            return;
        // Same song, sharper image (thumbnail → full size): a quick dissolve
        // instead of the full "new cover" animation.
        const trackId = this._state.track?.id ?? null;
        const upgrade = !instant && this._path && path && trackId === this._trackId;
        this._path = path;
        this._trackId = trackId;
        const layer = new St.Widget({
            style_class: 'flow-art-layer',
            x_expand: true,
            y_expand: true,
            opacity: instant ? 255 : 0,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        if (path)
            layer.set_style(artStyle(path, this._radius));
        else
            layer.add_style_class_name('flow-art-empty');
        this.add_child(layer);
        const old = this._layer;
        this._layer = layer;
        if (upgrade) {
            layer.ease({opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else if (!instant) {
            layer.set_scale(1.06, 1.06);
            layer.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 520,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        }
        if (old && upgrade) {
            // Keep the thumbnail underneath until the sharp copy covers it.
            old.ease({opacity: 0, duration: 180, delay: 180,
                mode: Clutter.AnimationMode.LINEAR, onStopped: () => old.destroy()});
        } else if (old) {
            old.ease({opacity: 0, scale_x: 0.94, scale_y: 0.94, duration: 420,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => old.destroy()});
        }
    }
});

// ── Text that cross-fades + slides when its content changes ─────────────
export const SwapLabel = GObject.registerClass(
class FlowwMusicSwapLabel extends St.Widget {
    _init({styleClass, distance = 6, align = 'left'} = {}) {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, clip_to_allocation: false});
        this._styleClass = styleClass;
        this._distance = distance;
        this._align = align;
        this._label = this._make('');
        this.add_child(this._label);
    }

    _make(text) {
        const l = new St.Label({
            style_class: this._styleClass,
            text,
            x_expand: true,
            x_align: this._align === 'center' ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return l;
    }

    get text() {
        return this._label.text;
    }

    get label() {
        return this._label;
    }

    setText(text, animate = true) {
        if (text === this._label.text)
            return;
        if (!animate || !this.mapped) {
            this._label.text = text;
            return;
        }
        const old = this._label;
        const next = this._make(text);
        next.opacity = 0;
        next.translation_y = this._distance;
        this.add_child(next);
        this._label = next;
        next.ease({opacity: 255, translation_y: 0, duration: 380, delay: 60,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        old.ease({opacity: 0, translation_y: -this._distance, duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD, onStopped: () => old.destroy()});
    }
});

// ── Scrubber ────────────────────────────────────────────────────────────
// Fill uses scale_x (no relayout per frame). Grows on hover like Apple's.
export const Scrubber = GObject.registerClass(
class FlowwMusicScrubber extends St.BoxLayout {
    _init(state, {showTimes = true} = {}) {
        super._init({orientation: Clutter.Orientation.VERTICAL, style_class: 'flow-scrubber', x_expand: true});
        this._state = state;

        this._hit = new St.Widget({
            style_class: 'flow-scrubber-hit',
            reactive: true,
            track_hover: true,
            x_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });
        this._track = new St.Widget({
            style_class: 'flow-scrubber-track',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({
            style_class: 'flow-scrubber-fill',
            x_expand: true,
            y_expand: true,
            pivot_point: new Graphene.Point({x: 0, y: 0.5}),
        });
        this._track.add_child(this._fill);
        this._hit.add_child(this._track);
        this.add_child(this._hit);

        if (showTimes) {
            const times = new St.BoxLayout({style_class: 'flow-scrubber-times', x_expand: true});
            this._elapsed = new St.Label({style_class: 'flow-time', x_expand: true});
            this._remaining = new St.Label({style_class: 'flow-time', x_align: Clutter.ActorAlign.END});
            times.add_child(this._elapsed);
            times.add_child(this._remaining);
            this.add_child(times);
        }

        this._grow = new Spring(1, Presets.snappy);
        this._dragging = false;
        this._lastSecond = -1;
        this._ticker = new Ticker(this);
        this._ticker.add(dt => this._tick(dt));

        this._hit.connect('notify::hover', () => {
            this._grow.target = this._hit.hover || this._dragging ? 1.9 : 1;
            this._ticker.wake();
        });

        const pan = new Clutter.PanGesture();
        pan.set_begin_threshold(0);
        pan.connect('recognize', () => {
            this._grab = global.stage.grab(this._hit);
            this._dragging = true;
            this._dragFrac(pan);
        });
        pan.connect('pan-update', () => this._dragFrac(pan));
        const ungrab = () => {
            this._grab?.dismiss();
            this._grab = null;
        };
        pan.connect('end', () => {
            ungrab();
            this._dragging = false;
            if (this._dragFraction !== undefined)
                state.seekTo(this._dragFraction * state.duration);
            this._grow.target = this._hit.hover ? 1.9 : 1;
            this._ticker.wake();
        });
        pan.connect('cancel', () => {
            ungrab();
            this._dragging = false;
            this._ticker.wake();
        });
        this._hit.add_action(pan);

        bindState(this, state, {
            'playback': () => this._ticker.wake(),
            'seeked': () => this._ticker.wake(),
            'track': () => this._ticker.wake(),
            'heartbeat': () => this._ticker.wake(),
        });
        this.connect('destroy', () => this._ticker.destroy());
    }

    _dragFrac(pan) {
        const c = pan.get_centroid_abs();
        const [x] = this._track.get_transformed_position();
        const [w] = this._track.get_transformed_size();
        this._dragFraction = clamp((c.x - x) / Math.max(1, w), 0, 1);
        this._ticker.wake();
    }

    _tick(dt) {
        const st = this._state;
        const dur = st.duration;
        const pos = this._dragging ? this._dragFraction * dur : st.position();
        const frac = dur > 0 ? clamp(pos / dur, 0, 1) : 0;
        this._fill.set_scale(frac, 1);
        const growing = this._grow.step(dt);
        this._track.set_scale(1, this._grow.value);
        const sec = Math.floor(pos);
        if (this._elapsed && (sec !== this._lastSecond || !this._elapsed.text)) {
            this._lastSecond = sec;
            this._elapsed.text = formatTime(pos);
            this._remaining.text = `-${formatTime(dur - pos)}`;
        }
        return st.playing || growing || this._dragging;
    }
});

// ── Transport controls with springy press feedback ──────────────────────
const ControlButton = GObject.registerClass(
class FlowwMusicControlButton extends St.Button {
    _init(iconName, {size = 20, styleClass = 'flow-control', label = null, gicon = null, tooltip = ''} = {}) {
        let icon;
        if (label)
            icon = new St.Label({text: label, style_class: 'flow-control-label', y_align: Clutter.ActorAlign.CENTER});
        else if (gicon)
            icon = new St.Icon({gicon, icon_size: size});
        else
            icon = new St.Icon({icon_name: iconName, icon_size: size});
        super._init({
            style_class: styleClass,
            child: icon,
            accessible_name: tooltip,
            can_focus: true,
            track_hover: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });
        this._icon = icon;
        this._spring = new Spring(1, Presets.bouncy);
        this._ticker = new Ticker(this);
        this._ticker.add(dt => {
            const m = this._spring.step(dt);
            this.set_scale(this._spring.value, this._spring.value);
            return m;
        });
        this.connect('notify::pressed', () => {
            this._spring.target = this.pressed ? 0.82 : 1;
            if (!this.pressed)
                this._spring.velocity += 3; // a little pop on release
            this._ticker.wake();
        });
        this.connect('destroy', () => this._ticker.destroy());
    }

    setActive(on) {
        if (on)
            this.add_style_class_name('flow-control-on');
        else
            this.remove_style_class_name('flow-control-on');
    }

    setIcon(name) {
        if (this._icon.icon_name === name)
            return;
        this._icon.ease({
            opacity: 0, scale_x: 0.5, scale_y: 0.5, duration: 110,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                this._icon.icon_name = name;
                this._icon.set_pivot_point(0.5, 0.5);
                this._icon.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 260,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK});
            },
        });
    }
});

// Spotify DJ's mark, shipped as a symbolic icon so it follows the text colour.
// Made per use, never at import (nothing may be built before enable()).
export function djIcon() {
    return new Gio.FileIcon({
        file: Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent()
            .get_child('icons').get_child('spotify-dj-symbolic.svg'),
    });
}

const LOOP_ICONS = {
    None: 'media-playlist-repeat-symbolic',
    Playlist: 'media-playlist-repeat-symbolic',
    Track: 'media-playlist-repeat-song-symbolic',
};

// prev / play / next; `extended` adds shuffle, repeat (off → all → one) and,
// while Spotify's DJ is playing, the DJ mark (click: a new DJ set):
//   ⤮  ⏮  ⏯  ⏭  ↻  (DJ)
// Buttons the current player can't honour (other apps) are hidden.
export const Controls = GObject.registerClass(
class FlowwMusicControls extends St.BoxLayout {
    _init(state, {size = 20, playSize = 28, extended = false, styleClass = 'flow-controls'} = {}) {
        super._init({style_class: styleClass, x_align: Clutter.ActorAlign.CENTER});
        this._state = state;
        const small = Math.round(size * 0.8);
        const toggle = 'flow-control flow-control-toggle';
        if (extended) {
            this._shuffle = new ControlButton('media-playlist-shuffle-symbolic', {size: small, styleClass: toggle, tooltip: 'Shuffle'});
            this._shuffle.connect('clicked', () => state.toggleShuffle());
            this.add_child(this._shuffle);
        }
        this._prev = new ControlButton('media-skip-backward-symbolic', {size, tooltip: 'Previous'});
        this._play = new ControlButton(this._playIcon(), {size: playSize, styleClass: 'flow-control flow-control-play', tooltip: 'Play/Pause'});
        this._next = new ControlButton('media-skip-forward-symbolic', {size, tooltip: 'Next'});
        this._prev.connect('clicked', () => state.previous());
        this._play.connect('clicked', () => state.playPause());
        this._next.connect('clicked', () => state.next());
        this.add_child(this._prev);
        this.add_child(this._play);
        this.add_child(this._next);
        if (extended) {
            this._loop = new ControlButton(LOOP_ICONS.None, {size: small, styleClass: toggle, tooltip: 'Repeat'});
            this._loop.connect('clicked', () => state.cycleLoop());
            this.add_child(this._loop);
            this._dj = new ControlButton(null, {gicon: djIcon(), size: Math.round(small * 1.25),
                styleClass: 'flow-control flow-control-dj', tooltip: 'Switch up the DJ'});
            this._dj.visible = false;
            this._dj.connect('clicked', () => state.startDJ());
            this.add_child(this._dj);
            this._syncOptions();
        }
        bindState(this, state, {
            'playback': () => this._play.setIcon(this._playIcon()),
            'options': () => this._syncOptions(),
            'availability': () => this._syncOptions(),
            'dj': () => this._syncOptions(),
        });
    }

    _syncOptions() {
        if (!this._shuffle)
            return;
        const st = this._state;
        this._shuffle.visible = st.hasShuffle ?? true;
        this._loop.visible = st.hasLoop ?? true;
        const dj = !!(st.isSpotify && st.djActive);
        if (dj !== this._dj.visible) {
            this._dj.visible = dj;
            if (dj && this.mapped) {
                // Pops in like a pressed button letting go.
                this._dj.set_scale(0.4, 0.4);
                this._dj.opacity = 0;
                this._dj.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 420,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK});
            }
        }
        this._shuffle.setActive(this._state.shuffle);
        const loop = this._state.loop;
        this._loop.setActive(loop !== 'None');
        this._loop.setIcon(LOOP_ICONS[loop] ?? LOOP_ICONS.None);
    }

    _playIcon() {
        return this._state.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
    }
});

// ── Equalizer bars (the pill's "now playing" pulse) ─────────────────────
export const EqBars = GObject.registerClass(
class FlowwMusicEqBars extends St.BoxLayout {
    _init(state) {
        super._init({style_class: 'flow-eq', y_align: Clutter.ActorAlign.CENTER});
        this._state = state;
        this._bars = [0, 1, 2].map(() => {
            const b = new St.Widget({
                style_class: 'flow-eq-bar',
                y_align: Clutter.ActorAlign.CENTER,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            });
            this.add_child(b);
            return b;
        });
        this._env = new Spring(state.playing ? 1 : 0, Presets.gentle);
        this._t = 0;
        this._ticker = new Ticker(this);
        this._ticker.add(dt => this._tick(dt));
        bindState(this, state, {
            'playback': () => {
                this._env.target = state.playing ? 1 : 0;
                this._ticker.wake();
            },
        });
        this.connect('destroy', () => this._ticker.destroy());
        this._tick(0);
    }

    _tick(dt) {
        this._t += dt;
        const moving = this._env.step(dt);
        const freqs = [[5.1, 2.3], [3.7, 6.1], [4.4, 1.7]];
        this._bars.forEach((b, i) => {
            const [f1, f2] = freqs[i];
            const n = 0.5 + 0.3 * Math.sin(this._t * f1 + i * 1.7) + 0.2 * Math.sin(this._t * f2 + i);
            const h = lerp(0.28, 0.25 + 0.75 * n, this._env.value);
            b.set_scale(1, h);
        });
        return this._state.playing || moving;
    }
});
