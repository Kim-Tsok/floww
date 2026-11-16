// Full-screen "now playing": art, transport, a clock and big lyrics over the
// living album-art gradient. Hosted by the lock screen (Floww Music's own,
// and Floww Lock's through the api) and by the desktop fullscreen view.
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ 9:41                                              (☀) (⤡)    │
//   │ Saturday, November 15                                        │
//   │  ┌────────┐                                                  │
//   │  │  art   │      lyric line                                  │
//   │  └────────┘      CURRENT LYRIC LINE                          │
//   │  Title           lyric line                                  │
//   │  Artist                                                      │
//   │  ───●──────                                                  │
//   │  ⤮ ⏮ ⏯ ⏭ ↻                                                   │
//   │                     Esc to exit                              │
//   └──────────────────────────────────────────────────────────────┘
//
// Without lyrics (none / instrumental / offline) the lyrics column folds
// away and the art glides to the centre, growing, with a visualizer and a
// quiet caption under it. A spring blends the two layouts.
//
// present(from) / dismiss(to): the view grows out of `from` (the widget
// that was clicked) and shrinks back into `to`. The gradient morphs from
// that rectangle to the full screen first, then the content rises in,
// staggered. One spring drives all of it, so it can reverse half way.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Spring, Ticker, Presets, lerp, clamp} from '../anim/spring.js';
import {AmbientBackground, ArtView, SwapLabel, Scrubber, Controls, bindState} from './widgets.js';
import {LyricsView, makeRefreshButton, noLyricsCaption} from './lyricsView.js';
import {Visualizer} from './visualizer.js';
import {holdAwake} from '../inhibit.js';

const PRESENT = {response: 0.62, dampingRatio: 0.9};
const CHROME_IDLE_MS = 3000;
const PAUSED_RELEASE_S = 10 * 60; // stop keeping the screen on after this long paused

const PAD_X = 112;      // left edge of the art column
const PAD_R = 96;
const PAD_TOP = 96;
const COLUMN_GAP = 88;  // art column → lyrics
const CLOCK_TOP = 44;
const VIZ_GAP = 30;
const ART_MAX = 340;
const ART_MAX_ALONE = 440;
const ART_MIN = 160;

// Allocated size; [0, 0] before the first allocation (Clutter starts the
// box out at ±infinity) — and never width/height, which would ask an
// unstaged widget for its preferred size.
function allocSize(actor) {
    const box = actor.get_allocation_box();
    const w = box.get_width(), h = box.get_height();
    return Number.isFinite(w) && Number.isFinite(h) ? [Math.max(0, w), Math.max(0, h)] : [0, 0];
}

const smooth = t => {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
};

// Pointer over a button / scrubber / lyric line inside `container`?
export function pointerOnControl(container) {
    const [x, y] = global.get_pointer();
    let a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
    while (a && a !== container) {
        if (a instanceof St.Button || a.has_style_class_name?.('flow-scrubber-hit'))
            return true;
        a = a.get_parent();
    }
    return false;
}

function rectOf(actor, root) {
    if (!actor?.mapped)
        return null;
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    let [rx, ry] = root.get_transformed_position();
    // NaN before the first allocation.
    if (![x, y, w, h].every(Number.isFinite) || w < 2 || h < 2)
        return null;
    if (!Number.isFinite(rx) || !Number.isFinite(ry))
        [rx, ry] = root.get_position().map(v => (Number.isFinite(v) ? v : 0));
    return {x: x - rx, y: y - ry, w, h};
}

const ImmersiveClock = GObject.registerClass(
class FlowwMusicImmersiveClock extends St.BoxLayout {
    _init() {
        super._init({orientation: Clutter.Orientation.VERTICAL, style_class: 'flow-immersive-clock'});
        this._time = new St.Label({style_class: 'flow-immersive-clock-time'});
        this._date = new St.Label({style_class: 'flow-immersive-clock-date'});
        this.add_child(this._time);
        this.add_child(this._date);
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wall = new GnomeDesktop.WallClock({time_only: true});
        this._wallId = this._wall.connect('notify::clock', () => this._sync());
        this._ifaceId = this._iface.connect('changed::clock-format', () => this._sync());
        this.connect('destroy', () => this._onDestroy());
        this._sync();
    }

    _onDestroy() {
        if (this._wallId)
            this._wall.disconnect(this._wallId);
        this._wallId = 0;
        if (this._ifaceId)
            this._iface.disconnect(this._ifaceId);
        this._ifaceId = 0;
        this._wall = null;
        this._iface = null;
    }

    _sync() {
        const now = GLib.DateTime.new_now_local();
        const h24 = this._iface.get_string('clock-format') === '24h';
        this._time.text = now.format(h24 ? '%H:%M' : '%-l:%M');
        this._date.text = now.format('%A, %B %-d');
    }
});

export const ImmersiveView = GObject.registerClass({
    Signals: {
        'close-request': {},
        'progress': {param_types: [GObject.TYPE_DOUBLE]},
        'closed': {},
    },
}, class FlowwMusicImmersive extends St.Widget {
    _init(state, settings, {clock = true, exitButton = false, hideCursor = false,
        hint = 'Click the background to go back · type to unlock'} = {}) {
        super._init({
            style_class: 'flow-immersive',
            x_expand: true,
            y_expand: true,
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._state = state;
        this._settings = settings;
        this._hideCursor = hideCursor;
        this._open = false;
        this._from = null;

        this._bg = new AmbientBackground(state, {styleClass: 'flow-immersive-bg', dim: 0.78});
        this._bg.set_pivot_point(0, 0);
        this.add_child(this._bg);

        // ── Art column ──
        this._side = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'flow-immersive-side',
        });
        this._artSize = ART_MAX;
        this._side.set_width(ART_MAX);
        this._art = new ArtView(state, {size: ART_MAX, radius: 18, pauseScale: 0.9, styleClass: 'flow-art flow-art-big'});
        this._title = new SwapLabel({styleClass: 'flow-title flow-title-big'});
        this._artist = new SwapLabel({styleClass: 'flow-artist flow-artist-big'});
        this._scrubber = new Scrubber(state);
        this._controls = new Controls(state, {size: 26, playSize: 38, extended: true,
            styleClass: 'flow-controls flow-controls-extended'});
        for (const a of [this._art, this._title, this._artist, this._scrubber, this._controls])
            this._side.add_child(a);
        this.add_child(this._side);

        // ── Lyrics ──
        this._lyrics = new LyricsView(state, settings, {
            fontSize: 40,
            anchor: 0.34,
            styleClass: 'flow-lyrics flow-immersive-lyrics',
            fade: [0.16, 0.24],
            maxBlur: 5,
            autoScrollPlain: true,
        });
        this.add_child(this._lyrics);

        // ── No lyrics: visualizer + caption ──
        this._viz = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'flow-viz-box flow-immersive-viz',
            opacity: 0,
            visible: false,
        });
        this._viz.add_child(new Visualizer(state, settings, {height: 88}));
        const row = new St.BoxLayout({style_class: 'flow-viz-caption-row', x_align: Clutter.ActorAlign.CENTER});
        this._caption = new St.Label({style_class: 'flow-viz-caption', y_align: Clutter.ActorAlign.CENTER});
        this._refresh = makeRefreshButton(state, {size: 13});
        row.add_child(this._caption);
        row.add_child(this._refresh);
        this._viz.add_child(row);
        this.add_child(this._viz);

        // ── Clock ──
        this._clock = clock ? new ImmersiveClock() : null;
        if (this._clock)
            this.add_child(this._clock);

        // ── Chrome: top-right buttons + hint, fade out when idle ──
        this._chrome = new St.BoxLayout({style_class: 'flow-immersive-chrome'});
        this._awakeBtn = this._chromeButton('display-brightness-symbolic', 'Keep the screen on',
            () => settings.set_boolean('keep-awake', !settings.get_boolean('keep-awake')));
        this._chrome.add_child(this._awakeBtn);
        if (exitButton) {
            this._chrome.add_child(this._chromeButton('view-restore-symbolic', 'Exit full screen',
                () => this.emit('close-request')));
        }
        this.add_child(this._chrome);
        this._hint = new St.Label({style_class: 'flow-immersive-hint', text: hint});
        this.add_child(this._hint);
        this._chromeShown = true;

        // Click the background to go back.
        const back = new Clutter.ClickGesture();
        back.connect('may-recognize', () => this._open && !pointerOnControl(this));
        back.connect('recognize', () => this.emit('close-request'));
        this.add_action(back);
        this.connect('captured-event', (a, event) => {
            if (event.type() === Clutter.EventType.MOTION)
                this._poke();
            return Clutter.EVENT_PROPAGATE;
        });

        // Springs: presentation (0 hidden … 1 open) and layout (0 lyrics, 1 none).
        this._p = new Spring(0, PRESENT, 0.001);
        this._mix = new Spring(0, Presets.bouncy, 0.001);
        this._mode = null;
        this._ticker = new Ticker(this);
        this._ticker.add(dt => this._tick(dt));

        this._awakeId = settings.connect('changed::keep-awake', () => this._syncAwake());
        bindState(this, state, {
            'track': () => this._syncTrack(true),
            'lyrics': () => this._syncMode(),
            'availability': () => this._syncMode(),
            'playback': () => this._syncAwake(),
        });
        this.connect('notify::allocation', () => {
            const size = allocSize(this).join('x');
            if (size !== this._lastSize) {
                this._lastSize = size;
                this._ticker.wake();
            }
        });
        this.connect('destroy', () => this._onDestroy());

        this._syncTrack(false);
        this._syncMode(true);
        this._syncAwake();
        this._apply();
    }

    _chromeButton(icon, label, cb) {
        const btn = new St.Button({
            style_class: 'flow-immersive-button',
            child: new St.Icon({icon_name: icon, icon_size: 18}),
            accessible_name: label,
            can_focus: true,
            track_hover: true,
        });
        btn.connect('clicked', cb);
        return btn;
    }

    get isOpen() {
        return this._open;
    }

    // ── Open / close ────────────────────────────────────────────────────
    present(from = null) {
        if (this._open)
            return;
        this._open = true;
        this._closedEmitted = false;
        if (this._p.value < 0.01)
            this._from = rectOf(from, this) ?? this._from;
        this.show();
        this.reactive = true;
        this._p.target = 1;
        this._poke();
        this._syncAwake();
        this._ticker.wake();
    }

    dismiss(to = null) {
        if (!this._open)
            return;
        this._open = false;
        this._from = rectOf(to, this) ?? this._from;
        this.reactive = false;
        this._p.target = 0;
        this._setChrome(true);
        this._showPointer();
        this._syncAwake();
        this._ticker.wake();
    }

    // Jump to closed (the lock screen going away, etc.).
    hideNow() {
        this._open = false;
        this._p.jump(0);
        this.reactive = false;
        this._showPointer();
        this._syncAwake();
        this._apply();
        this.hide();
    }

    // ── Keep awake ──────────────────────────────────────────────────────
    _syncAwake() {
        const on = this._settings.get_boolean('keep-awake');
        if (on)
            this._awakeBtn.add_style_class_name('flow-immersive-button-on');
        else
            this._awakeBtn.remove_style_class_name('flow-immersive-button-on');
        this._awakeBtn.accessible_name = on ? 'Screen stays on' : 'Keep the screen on';

        // A view left open on a paused song shouldn't hold the screen
        // forever: let go after a while, take it again on play.
        if (this._state.playing || !this._open) {
            if (this._pauseTimer)
                GLib.source_remove(this._pauseTimer);
            this._pauseTimer = 0;
            this._pausedLong = false;
        } else if (!this._pauseTimer && !this._pausedLong) {
            this._pauseTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PAUSED_RELEASE_S, () => {
                this._pauseTimer = 0;
                this._pausedLong = true;
                this._syncAwake();
                return GLib.SOURCE_REMOVE;
            });
        }
        holdAwake(this, this._open && on && !this._pausedLong);
    }

    // ── Chrome / pointer idle ───────────────────────────────────────────
    _poke() {
        this._showPointer();
        this._setChrome(true);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        if (!this._open)
            return;
        this._idleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHROME_IDLE_MS, () => {
            this._idleId = 0;
            if (this._open && !this._chrome.hover) {
                this._setChrome(false);
                this._hidePointer();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _setChrome(show) {
        if (show === this._chromeShown)
            return;
        this._chromeShown = show;
        this._ticker.wake();
    }

    _cursorTracker() {
        try {
            return global.backend.get_cursor_tracker();
        } catch {
            return null;
        }
    }

    _seat() {
        try {
            return global.stage.context.get_backend().get_default_seat();
        } catch {
            return null;
        }
    }

    // Hiding the cursor normally also drops pointer focus, and then no
    // actor gets motion events, so moving the mouse could never bring it
    // back. Keep the focus while hidden (the screen shield does the same).
    _hidePointer() {
        if (!this._hideCursor || this._cursorHidden)
            return;
        this._seat()?.inhibit_unfocus();
        this._cursorTracker()?.inhibit_cursor_visibility();
        this._cursorHidden = true;
        // Backstop in case motion events still don't reach us: watch the
        // pointer position itself while the cursor is hidden.
        const [x0, y0] = global.get_pointer();
        this._pointerWatch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            const [x, y] = global.get_pointer();
            if (x === x0 && y === y0)
                return GLib.SOURCE_CONTINUE;
            this._pointerWatch = 0;
            this._poke();
            return GLib.SOURCE_REMOVE;
        });
    }

    _showPointer() {
        if (!this._cursorHidden)
            return;
        if (this._pointerWatch)
            GLib.source_remove(this._pointerWatch);
        this._pointerWatch = 0;
        this._cursorTracker()?.uninhibit_cursor_visibility();
        this._seat()?.uninhibit_unfocus();
        this._cursorHidden = false;
    }

    // ── Content ─────────────────────────────────────────────────────────
    _syncTrack(animate) {
        this._title.setText(this._state.track?.title ?? '', animate);
        this._artist.setText(this._state.track?.artist ?? '', animate);
    }

    _syncMode(instant = false) {
        const kind = this._state.lyrics.kind;
        if (kind === 'loading' && !instant)
            return; // keep whatever is showing until we know
        const caption = this._state.available ? noLyricsCaption(kind) : null;
        if (caption) {
            this._caption.text = caption;
            this._refresh.visible = kind !== 'instrumental';
        }
        const mode = caption ? 'none' : 'lyrics';
        if (mode === this._mode && !instant)
            return;
        this._mode = mode;
        this._mix.target = mode === 'none' ? 1 : 0;
        if (instant || !this.mapped)
            this._mix.jump(this._mix.target);
        this._ticker.wake();
    }

    _tick(dt) {
        let moving = this._p.step(dt);
        if (this._mix.step(dt))
            moving = true;
        this._chromeA ??= 1;
        const chromeTarget = this._chromeShown ? 1 : 0;
        if (Math.abs(this._chromeA - chromeTarget) > 0.001) {
            const k = 1 - Math.exp(-dt / (this._chromeShown ? 0.12 : 0.35));
            this._chromeA = lerp(this._chromeA, chromeTarget, k);
            if (Math.abs(this._chromeA - chromeTarget) < 0.01)
                this._chromeA = chromeTarget;
            moving = true;
        }

        // Art size follows the layout; resizing is a relayout, so only do it
        // here (never from allocate).
        const size = Math.round(this._artTarget());
        if (size !== this._artSize) {
            this._artSize = size;
            this._art.set_size(size, size);
            this._side.set_width(Math.max(size, ART_MIN + 120));
        }
        if (moving)
            this.queue_relayout(); // layout blends with the springs
        this._apply();

        if (!moving && !this._open && this._p.value < 0.01) {
            this.hide();
            if (!this._closedEmitted) {
                this._closedEmitted = true;
                this.emit('closed');
            }
        }
        return moving;
    }

    // Biggest art that leaves room for everything else.
    _artTarget() {
        const [, H] = allocSize(this);
        if (!(H > 0))
            return this._artSize;
        const m = clamp(this._mix.value, 0, 1);
        const sideH = this._side.get_preferred_height(this._side.width)[1];
        const others = sideH - this._artSize;
        const top = this._topReserve();
        const hintH = this._hint.get_preferred_height(-1)[1];
        const vizH = this._viz.get_preferred_height(-1)[1] + VIZ_GAP;
        const free = H - top - hintH - 36 - others - vizH * m;
        const cap = lerp(ART_MAX, ART_MAX_ALONE, m);
        return clamp(free, ART_MIN, cap);
    }

    _topReserve() {
        if (!this._clock)
            return PAD_TOP;
        const [, ch] = this._clock.get_preferred_height(-1);
        return Math.max(PAD_TOP, CLOCK_TOP + ch + 28);
    }

    // Per-frame transforms: presentation + layout blend.
    _apply() {
        const p = this._p.value;
        this.emit('progress', clamp(p, 0, 1));
        const [W, H] = allocSize(this);

        // Gradient: from the source rectangle to the whole screen.
        // Everything is clipped to that growing rectangle, so the content is
        // revealed by the opening "window" instead of floating in from
        // outside it.
        const r = this._from ?? {x: W * 0.04, y: H * 0.04, w: W * 0.92, h: H * 0.92};
        const e = clamp(p, 0, 1.08);
        const rx = lerp(r.x, 0, e), ry = lerp(r.y, 0, e);
        const rw = lerp(r.w, W, e), rh = lerp(r.h, H, e);
        if (W > 0 && H > 0) {
            this._bg.set_scale(rw / W, rh / H);
            this._bg.translation_x = rx;
            this._bg.translation_y = ry;
            if (p < 0.999 || !this._open)
                this.set_clip(rx, ry, Math.max(0, rw), Math.max(0, rh));
            else if (this.has_clip)
                this.remove_clip();
        }
        this._bg.opacity = Math.round(255 * smooth(p / 0.18));

        // Content: staggered rise once the gradient is mostly in place.
        const stage = (actor, delay, extra = 1) => {
            const q = smooth((p - delay) / 0.42);
            actor.opacity = Math.round(255 * q * extra);
            actor.translation_y = Math.round(18 * (1 - q));
            return q;
        };
        const m = clamp(this._mix.value, 0, 1);
        stage(this._art, 0.22);
        stage(this._title, 0.3);
        stage(this._artist, 0.34);
        stage(this._scrubber, 0.4);
        stage(this._controls, 0.44);
        stage(this._lyrics, 0.36, 1 - m);
        this._lyrics.translation_x = Math.round(60 * m);
        this._lyrics.visible = m < 0.99;
        stage(this._viz, 0.46, m);
        this._viz.visible = m > 0.01;
        if (this._clock)
            stage(this._clock, 0.5);
        const c = this._chromeA ?? 1;
        stage(this._chrome, 0.56, c);
        stage(this._hint, 0.6, c);
        this._chrome.reactive = c > 0.5;
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const W = box.get_width(), H = box.get_height();
        const put = (a, x, y, w, h) => a.allocate(new Clutter.ActorBox({
            x1: Math.round(x), y1: Math.round(y), x2: Math.round(x + w), y2: Math.round(y + h)}));
        const nat = a => {
            const [, w] = a.get_preferred_width(-1);
            const [, h] = a.get_preferred_height(w);
            return [w, h];
        };

        put(this._bg, 0, 0, W, H);

        const [hw, hh] = nat(this._hint);
        put(this._hint, (W - hw) / 2, H - hh, hw, hh);
        const [bw, bh] = nat(this._chrome);
        put(this._chrome, W - bw - 32, 44, bw, bh);
        if (this._clock) {
            const [cw, ch] = nat(this._clock);
            put(this._clock, PAD_X, CLOCK_TOP, cw, ch);
        }

        const m = clamp(this._mix.value, -0.05, 1.05);
        const top = this._topReserve();
        const bottom = H - hh - 12;
        const sw = this._side.width > 0 ? this._side.width : ART_MAX;
        const [, sh] = this._side.get_preferred_height(sw);
        const [, vh] = this._viz.get_preferred_height(-1);
        const vw = Math.min(W * 0.5, 560);

        // Lyrics layout: art column on the left, vertically centred.
        const lx = PAD_X;
        const ly = Math.max(top, (top + bottom - sh) / 2);
        // No lyrics: art column + visualizer centred on screen.
        const block = sh + VIZ_GAP + vh;
        const nx = (W - sw) / 2;
        const ny = Math.max(top, (top + bottom - block) / 2);
        const sx = lerp(lx, nx, m), sy = lerp(ly, ny, m);
        put(this._side, sx, sy, sw, sh);
        put(this._viz, sx + (sw - vw) / 2, sy + sh + VIZ_GAP, vw, vh);

        const lyrX = PAD_X + ART_MAX + COLUMN_GAP;
        put(this._lyrics, lyrX, top, Math.max(100, W - lyrX - PAD_R), Math.max(100, bottom - top));
    }

    _onDestroy() {
        this._settings.disconnect(this._awakeId);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        if (this._pauseTimer)
            GLib.source_remove(this._pauseTimer);
        this._showPointer();
        holdAwake(this, false);
        this._ticker.destroy();
    }
});

export function makeImmersive(state, settings, opts = {}) {
    return new ImmersiveView(state, settings, opts);
}
