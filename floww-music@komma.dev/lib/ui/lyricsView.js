// The Apple Music–style lyrics renderer, shared by every surface.
//
// Motion model
//  • Every line owns a scroll-offset spring. When the active line changes,
//    each line below it starts chasing the new offset a little later than
//    the one above (stagger) — the cascading "waterfall".
//  • Inactive lines are dimmed, slightly shrunk and progressively blurred
//    by distance; the active line is lit by a GPU karaoke fill that follows
//    word timings.
//  • Long instrumental gaps show three breathing dots that fill in time.
//  • User scrolling detaches from playback (blur off, all lines readable),
//    and springs back after a short idle period. Clicking a line seeks.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Spring, Ticker, Presets, clamp} from '../anim/spring.js';
import {KaraokeEffect, FadeEffect} from './effects.js';
import {lineIndexAt, sungChars} from '../lyrics/lrc.js';
import {bindState} from './widgets.js';

const DIM = 0.38;          // inactive line brightness (also the unlit karaoke level)
const HOVER_DIM = 0.75;
// Text is rendered at the *active* size and only ever scaled down: scaling a
// label (or the karaoke offscreen buffer) up resamples its glyphs and makes
// them look soft and pixelated. The sung line sits at exactly 1.0 on whole
// pixels, so it stays razor sharp.
const RENDER_SCALE = 1.06;   // the sung line is this much larger than fontSize
const ACTIVE_SCALE = 1;
const INACTIVE_SCALE = 0.965 / RENDER_SCALE;
const STAGGER = 0.045;     // seconds between consecutive lines
const MAX_STAGGER_LINES = 8;
const LEAD = 0.18;         // scroll a hair before the line starts
const USER_SCROLL_IDLE = 2.6;
const DOT_COUNT = 3;

function utf8Len(cp) {
    return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

// offsets[i] = UTF-8 byte index of UTF-16 code unit i (Pango wants bytes).
function utf8Offsets(text) {
    const out = new Array(text.length + 1);
    let bytes = 0;
    for (let i = 0; i < text.length;) {
        const cp = text.codePointAt(i);
        const units = cp > 0xFFFF ? 2 : 1;
        out[i] = bytes;
        if (units === 2)
            out[i + 1] = bytes;
        bytes += utf8Len(cp);
        i += units;
    }
    out[text.length] = bytes;
    return out;
}

// What to say instead of lyrics, or null when there is something to show
// (or it's still loading). Shared by every surface that swaps the lyrics
// for a visualizer.
export function noLyricsCaption(kind) {
    return {
        none: 'No lyrics for this song',
        offline: "Offline — lyrics will load when you're back",
        instrumental: 'Instrumental',
    }[kind] ?? null;
}

// Small, quiet "try again" button for when lyrics couldn't be found.
export function makeRefreshButton(state, {size = 14} = {}) {
    const icon = new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: size,
        pivot_point: new Graphene.Point({x: 0.5, y: 0.5})});
    const btn = new St.Button({
        style_class: 'flow-lyrics-refresh',
        child: icon,
        can_focus: true,
        track_hover: true,
        accessible_name: 'Look for lyrics again',
    });
    btn.connect('clicked', () => {
        icon.remove_all_transitions();
        icon.rotation_angle_z = 0;
        icon.ease({rotation_angle_z: 360, duration: 700, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        state.reloadLyrics();
    });
    return btn;
}

const Interlude = GObject.registerClass(
class FlowwMusicInterlude extends St.BoxLayout {
    _init(dotSize) {
        super._init({
            style_class: 'flow-interlude',
            pivot_point: new Graphene.Point({x: 0, y: 0.5}),
        });
        this.dots = [];
        for (let i = 0; i < DOT_COUNT; i++) {
            const d = new St.Widget({
                style_class: 'flow-interlude-dot',
                width: dotSize,
                height: dotSize,
                style: `border-radius: ${dotSize / 2}px;`,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            });
            this.add_child(d);
            this.dots.push(d);
        }
        this.connect('destroy', () => this._onDestroy());
    }

    _onDestroy() {
        this.dots.forEach(dot => dot.destroy());
        this.dots = [];
    }

    // p ∈ [0,1] through the gap; t = seconds for breathing.
    update(p, t) {
        const breathe = 1 + 0.07 * Math.sin(t * 2 * Math.PI / 2.4);
        // Final 12%: swell then shrink away, the Apple "pop".
        const tail = clamp((p - 0.88) / 0.12, 0, 1);
        const pop = tail < 0.35 ? 1 + tail * 0.4 : (1 + 0.14) * (1 - (tail - 0.35) / 0.65);
        const s = breathe * Math.max(0, pop);
        this.set_scale(s, s);
        this.dots.forEach((d, i) => {
            const local = clamp(p * DOT_COUNT - i, 0, 1);
            d.opacity = Math.round(255 * (DIM + (1 - DIM) * local));
        });
    }
});

export const LyricsView = GObject.registerClass(
class FlowwMusicLyricsView extends St.Widget {
    _init(state, settings, {
        fontSize = 22,
        spacing = 0.55,     // in em, between lines
        anchor = 0.3,       // active line top position (fraction of height)
        interactive = true,
        styleClass = 'flow-lyrics',
        fade = [0.1, 0.22],
        maxBlur = 4,
        emptyAlign = 'center',
        autoScrollPlain = false, // unsynced lyrics follow the song's progress
    } = {}) {
        super._init({
            style_class: styleClass,
            clip_to_allocation: true,
            reactive: interactive,
            x_expand: true,
            y_expand: true,
        });
        this._state = state;
        this._settings = settings;
        this._fontSize = fontSize;
        this._spacingEm = spacing;
        this._anchor = anchor;
        this._interactive = interactive;
        this._maxBlur = maxBlur;
        this._emptyAlign = emptyAlign;
        this._autoPlain = autoScrollPlain;

        this._items = [];
        this._active = -2;
        this._userOffset = new Spring(0, Presets.snappy);
        this._userScrolling = false;
        this._lastUserScroll = 0;
        this._width = 0;
        this._enter = 0;
        this._kind = null;

        this._column = new Clutter.Actor();
        this.add_child(this._column);
        this._message = null;

        this._fadeEffect = new FadeEffect();
        this._fadeEffect.setFade(...fade);
        this.add_effect(this._fadeEffect);

        this._karaoke = new KaraokeEffect();
        this._karaokeHost = null;

        this._ticker = new Ticker(this);
        this._ticker.add((dt, now) => this._tick(dt, now));

        this._blurSetting = settings.get_boolean('blur-lyrics');
        this._settingsId = settings.connect('changed::blur-lyrics', () => {
            this._blurSetting = settings.get_boolean('blur-lyrics');
            this._ticker.wake();
        });

        bindState(this, state, {
            'lyrics': () => this._rebuild(),
            'seeked': () => this._onSeek(),
            'playback': () => this._ticker.wake(),
            'track': () => this._ticker.wake(),
            'heartbeat': () => this._ticker.wake(),
        });

        this.connect('notify::mapped', () => {
            if (this.mapped) {
                // Coming back into view: land on the current line, don't
                // replay a long scroll from where we were when hidden.
                this._needsSnap = true;
                this._queueRemeasure();
            }
        });
        this.connect('destroy', () => this._onDestroy());

        if (interactive)
            this.connect('scroll-event', (a, e) => this._onScroll(e));

        this._rebuild();
    }

    // ── Building ────────────────────────────────────────────────────────
    _clear() {
        this._detachKaraoke();
        // Old lines drift up and dissolve while new ones arrive.
        for (const it of this._items) {
            const a = it.actor;
            it.dead = true;
            a.remove_all_transitions();
            a.ease({
                opacity: 0,
                translation_y: -24,
                duration: 260,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: () => a.destroy(),
            });
        }
        this._items = [];
        if (this._message) {
            const m = this._message;
            this._message = null;
            m.ease({opacity: 0, duration: 200, onStopped: () => m.destroy()});
        }
    }

    _lineStyle() {
        return `font-size: ${Math.round(this._fontSize * RENDER_SCALE)}px;`;
    }

    _makeLine(text, line, plain = false) {
        const label = new St.Label({
            style_class: 'flow-lyric-text',
            style: this._lineStyle(),
            text,
            x_align: Clutter.ActorAlign.START,
        });
        const ct = label.clutter_text;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.ellipsize = Pango.EllipsizeMode.NONE;

        const button = new St.Button({
            style_class: 'flow-lyric-line',
            child: label,
            reactive: this._interactive && !plain,
            can_focus: false,
            track_hover: this._interactive,
            x_align: Clutter.ActorAlign.START,
            pivot_point: new Graphene.Point({x: 0, y: 0.5}),
        });
        // St.Button re-centres its child; make the text span the full line
        // so it stays left-aligned and wraps at the line width.
        label.x_expand = true;
        label.x_align = Clutter.ActorAlign.FILL;
        if (this._interactive && !plain && line)
            button.connect('clicked', () => this._state.seekTo(line.start + 0.01));
        if (this._interactive) {
            button.connect('notify::hover', () => {
                this._applyStates(false);
                this._ticker.wake();
            });
        }

        const blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1});
        blur.enabled = false;
        label.add_effect_with_name('flow-blur', blur);

        return {
            kind: 'line',
            line,
            actor: button,
            label,
            blur,
            plain,
            height: 0,
            offset: new Spring(0, Presets.lyric, 0.05),
            opacity: new Spring(DIM, Presets.gentle),
            scale: new Spring(INACTIVE_SCALE, Presets.lyric, 0.0005),
            blurR: new Spring(0, Presets.gentle, 0.05),
            enter: new Spring(0, Presets.lyric),
            delayUntil: 0,
            offsets: null,
        };
    }

    _makeInterlude(line) {
        const dot = Math.round(this._fontSize * 0.42);
        const actor = new Interlude(dot);
        return {
            kind: 'interlude',
            line,
            actor,
            height: 0,
            offset: new Spring(0, Presets.lyric, 0.05),
            expand: new Spring(0, Presets.bouncy, 0.002),
            enter: new Spring(0, Presets.lyric),
            delayUntil: 0,
        };
    }

    _showMessage(text, sub = '', {refresh = false} = {}) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'flow-lyrics-message',
            x_expand: true,
            opacity: 0,
        });
        const title = new St.Label({text, style_class: 'flow-lyrics-message-title'});
        title.clutter_text.line_wrap = true;
        box.add_child(title);
        if (sub) {
            const subLabel = new St.Label({text: sub, style_class: 'flow-lyrics-message-sub'});
            subLabel.clutter_text.line_wrap = true;
            box.add_child(subLabel);
            if (this._emptyAlign === 'center')
                subLabel.x_align = Clutter.ActorAlign.CENTER;
        }
        if (refresh) {
            const btn = makeRefreshButton(this._state);
            btn.x_align = this._emptyAlign === 'center' ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
            box.add_child(btn);
        }
        if (this._emptyAlign === 'center') {
            box.x_align = Clutter.ActorAlign.CENTER;
            title.x_align = Clutter.ActorAlign.CENTER;
        }
        this._column.add_child(box);
        this._message = box;
        this._layoutMessage();
        box.translation_y = 10;
        box.ease({opacity: 255, translation_y: 0, duration: 420, delay: 120,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    _layoutMessage() {
        if (!this._message)
            return;
        const [w, h] = this.get_size();
        this._message.set_width(w);
        const [, mh] = this._message.get_preferred_height(w);
        this._message.set_position(0, Math.round((h - mh) * (this._emptyAlign === 'center' ? 0.5 : this._anchor)));
    }

    _rebuild() {
        const lyr = this._state.lyrics;
        if (lyr.kind === this._kind && lyr === this._source)
            return;
        this._source = lyr;
        this._kind = lyr.kind;
        this._clear();
        this._active = -2;
        this._userOffset.jump(0);

        switch (lyr.kind) {
        case 'synced':
            for (const line of lyr.lines) {
                const it = line.interlude ? this._makeInterlude(line) : this._makeLine(line.text, line);
                this._items.push(it);
                this._column.add_child(it.actor);
                it.actor.opacity = 0;
            }
            break;
        case 'plain':
            for (const text of lyr.plain) {
                const it = this._makeLine(text || ' ', null, true);
                this._items.push(it);
                this._column.add_child(it.actor);
                it.actor.opacity = 0;
            }
            break;
        case 'loading':
            break;
        case 'instrumental':
            this._showMessage('♪', 'Instrumental');
            break;
        case 'offline':
            if (this._state.available)
                this._showMessage("You're offline", 'Lyrics will load when you\'re back online', {refresh: true});
            break;
        default:
            if (this._state.available)
                this._showMessage('No lyrics for this song', this._state.track?.title ?? '', {refresh: true});
        }

        this._needsSnap = true;
        this._dirty = true;
        this._remeasure();
        // Staggered entrance.
        const now = GLib.get_monotonic_time() / 1e6;
        const first = Math.max(0, this._active);
        this._items.forEach((it, i) => {
            it.enter.jump(0);
            it.enterAt = now + 0.12 + Math.min(Math.abs(i - first), 10) * 0.04;
        });
        this._ticker.wake();
    }

    _queueRemeasure() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._laterId = 0;
                this._remeasure();
                this._ticker.wake();
                return GLib.SOURCE_REMOVE;
            });
    }

    // Lyrics never drive the host's size: the host decides, we fill it.
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const w = box.get_width(), h = box.get_height();
        if (w !== this._width)
            this._queueRemeasure();
        if (h !== this._lastH) {
            this._lastH = h;
            this._ticker.wake();
        }
    }

    _remeasure() {
        // Note: not has_allocation() — that is false whenever a relayout is
        // merely queued (e.g. right after we add the new lines).
        const w = this.get_allocation_box().get_width();
        if (!this.mapped || w <= 0)
            return;
        this._width = w;
        this._dirty = false;
        const node = this.get_theme_node();
        this._padX = node.get_padding(St.Side.LEFT);
        // Wrap as if already enlarged, so the active line never spills over.
        const lineW = Math.max(40, Math.floor((w - this._padX - node.get_padding(St.Side.RIGHT)) / ACTIVE_SCALE));
        for (const it of this._items) {
            if (it.kind === 'line') {
                it.actor.set_width(lineW);
                const [, h] = it.actor.get_preferred_height(lineW);
                it.height = Math.round(h);
                it.offsets = null; // layout changed → recompute karaoke geometry
            } else {
                const [, h] = it.actor.get_preferred_height(-1);
                it.height = Math.round(h + this._fontSize * 0.4);
            }
        }
        this._layoutMessage();
        if (this._needsSnap) {
            this._needsSnap = false;
            this._snapToPlayback();
        }
    }

    // ── Timing ──────────────────────────────────────────────────────────
    _currentIndex(t) {
        const lyr = this._state.lyrics;
        if (lyr.kind !== 'synced')
            return -1;
        return lineIndexAt(lyr.lines, t + LEAD);
    }

    _onSeek() {
        if (this._kind !== 'synced')
            return;
        // Jumps far away: glide everything together, no waterfall.
        const idx = this._currentIndex(this._state.lyricTime());
        if (Math.abs(idx - this._active) > 2)
            this._setActive(idx, false);
        this._ticker.wake();
    }

    _snapToPlayback() {
        const idx = this._currentIndex(this._state.lyricTime());
        this._setActive(idx, false);
        const S = this._targetScroll();
        for (const it of this._items)
            it.offset.jump(S);
        this._applyStates(true);
    }

    _setActive(idx, stagger = true) {
        if (idx === this._active)
            return;
        const prev = this._active;
        this._active = idx;
        const now = GLib.get_monotonic_time() / 1e6;
        const forward = idx > prev;
        this._items.forEach((it, i) => {
            if (!stagger || !forward) {
                it.delayUntil = now;
                return;
            }
            // Lines from the active one downward follow progressively later.
            const k = clamp(i - idx, 0, MAX_STAGGER_LINES);
            it.delayUntil = now + k * STAGGER;
        });
        this._attachKaraoke();
        this._applyStates(false);
    }

    _applyStates(instant) {
        const blurOn = this._blurSetting && !this._userScrolling && this._kind === 'synced';
        this._items.forEach((it, i) => {
            const d = this._active < 0 ? i + 1 : Math.abs(i - this._active);
            const isActive = i === this._active;
            if (it.kind === 'interlude') {
                it.expand.target = isActive ? 1 : 0;
                if (instant)
                    it.expand.jump(it.expand.target);
                return;
            }
            let op, sc, br;
            if (it.plain) {
                op = 0.85; sc = 1; br = 0;
            } else if (isActive) {
                op = 1; sc = ACTIVE_SCALE; br = 0;
            } else {
                op = this._userScrolling || it.actor.hover ? HOVER_DIM : DIM;
                sc = INACTIVE_SCALE;
                br = blurOn && !it.actor.hover ? Math.min(d, this._maxBlur) * 0.9 : 0;
            }
            it.opacity.target = op;
            it.scale.target = sc;
            it.blurR.target = br;
            if (isActive)
                it.opacity.jump(1); // karaoke shader provides the dim → seamless
            if (instant) {
                it.opacity.jump(op);
                it.scale.jump(sc);
                it.blurR.jump(br);
            }
        });
    }

    _attachKaraoke() {
        this._detachKaraoke();
        const it = this._items[this._active];
        if (!it || it.kind !== 'line' || it.plain)
            return;
        it.label.add_effect_with_name('flow-karaoke', this._karaoke);
        this._karaokeHost = it;
        this._karaoke.setFill(0, 0, 1, 0.05, DIM);
    }

    _detachKaraoke() {
        if (this._karaokeHost) {
            this._karaokeHost.label.remove_effect(this._karaoke);
            this._karaokeHost = null;
        }
    }

    // Maps the sung character position onto (row, x) of the wrapped layout.
    _updateKaraoke(t) {
        const it = this._karaokeHost;
        if (!it)
            return;
        const line = it.line;
        const text = line.text;
        const layout = it.label.clutter_text.get_layout();
        if (!it.offsets)
            it.offsets = utf8Offsets(text);
        const rows = Math.max(1, layout.get_line_count());
        const w = Math.max(1, it.label.width);
        const c = clamp(sungChars(line, t), 0, text.length);
        if (c >= text.length) {
            this._karaoke.setFill(rows, 0, rows, 0.05, DIM);
            return;
        }
        const k = Math.floor(c);
        const frac = c - k;
        const [row, xLead] = layout.index_to_line_x(it.offsets[k], false);
        const [, xTrail] = layout.index_to_line_x(it.offsets[k], true);
        const x = (xLead + (xTrail - xLead) * frac) / Pango.SCALE;
        const feather = Math.min(0.12, (this._fontSize * 0.9) / w);
        // Bias forward by half the feather so the sung glyph is fully lit.
        this._karaoke.setFill(row, x / w + feather * 0.5, rows, feather, DIM);
    }

    // ── Layout per frame ────────────────────────────────────────────────
    _baseYs() {
        const ys = new Array(this._items.length);
        let y = 0;
        const gap = this._fontSize * this._spacingEm;
        for (let i = 0; i < this._items.length; i++) {
            const it = this._items[i];
            if (it.kind === 'interlude') {
                ys[i] = y;
                const e = Math.max(0, it.expand.value);
                y += (it.height + gap) * e;
            } else {
                // Lines scale around their vertical centre; reserve exactly
                // their visible height so neighbours never overlap or drift.
                const vis = it.height * Math.max(0, it.scale.value);
                ys[i] = y - (it.height - vis) / 2;
                y += vis + gap;
            }
        }
        return ys;
    }

    _targetScroll(ys = this._baseYs()) {
        const [, h] = this.get_size();
        if (this._kind === 'plain') {
            let auto = 0;
            if (this._autoPlain && this._state.duration > 0) {
                // Read along: the page drifts through the song, keeping
                // roughly where the singer should be a third of the way down.
                const last = this._items.length - 1;
                const total = (ys[last] ?? 0) + (this._items[last]?.height ?? 0);
                const frac = clamp(this._state.position() / this._state.duration, 0, 1);
                auto = Math.max(0, total - h * 0.6) * frac;
            }
            return -h * 0.08 + auto + this._userOffset.value;
        }
        const idx = Math.max(0, this._active);
        const base = ys[idx] ?? 0;
        return base - h * this._anchor + this._userOffset.value;
    }

    _tick(dt, nowUs) {
        if (!this._items.length) {
            this._detachKaraoke();
            return false;
        }
        // Measure synchronously if the width changed since the last frame
        // (frame callbacks run before layout, so this never shows a
        // half-laid-out state).
        if (this._dirty || this.get_allocation_box().get_width() !== this._width)
            this._remeasure();

        const now = nowUs / 1e6;
        const t = this._state.lyricTime();
        let moving = false;

        if (this._kind === 'synced' && !this._userScrolling) {
            const idx = this._currentIndex(t);
            if (idx !== this._active)
                this._setActive(idx, true);
        }

        if (this._userScrolling && now - this._lastUserScroll > USER_SCROLL_IDLE) {
            this._userScrolling = false;
            this._userOffset.target = 0;
            this._applyStates(false);
        }
        if (this._userOffset.step(dt))
            moving = true;

        // Interlude expansion affects base positions, so step those first.
        for (const it of this._items) {
            if (it.kind === 'interlude' && it.expand.step(dt))
                moving = true;
        }
        const ys = this._baseYs();
        const S = this._targetScroll(ys);
        const [, viewH] = this.get_size();
        const padX = this._padX ?? 0;

        for (let i = 0; i < this._items.length; i++) {
            const it = this._items[i];
            if (it.dead)
                continue;
            if (now >= it.delayUntil)
                it.offset.target = S;
            if (it.offset.step(dt))
                moving = true;
            if (now >= (it.enterAt ?? 0)) {
                it.enter.target = 1;
                if (it.enter.step(dt))
                    moving = true;
            } else {
                moving = true;
            }

            if (!it.height) {
                it.actor.visible = false; // not measured yet
                continue;
            }
            const y = ys[i] - it.offset.value;
            const h = it.height;
            const onScreen = y + h > -h - 40 && y < viewH + 40;
            it.actor.visible = onScreen;
            const enter = clamp(it.enter.value, 0, 1);

            if (it.kind === 'interlude') {
                const e = clamp(it.expand.value, 0, 1.2);
                it.actor.set_position(padX + 6, y + (h * e - h) / 2);
                it.actor.opacity = Math.round(255 * clamp(e, 0, 1) * enter);
                if (onScreen && e > 0.01) {
                    const p = clamp((t - it.line.start) / Math.max(0.1, it.line.end - it.line.start), 0, 1);
                    it.actor.update(p, now);
                    moving = moving || this._state.playing;
                }
                continue;
            }

            for (const s of [it.opacity, it.scale, it.blurR]) {
                if (s.step(dt))
                    moving = true;
            }
            // Whole pixels only: half-pixel offsets smear the glyphs.
            it.actor.set_position(Math.round(padX), Math.round(y + (1 - enter) * 22));
            it.actor.opacity = Math.round(255 * clamp(it.opacity.value, 0, 1) * enter);
            it.actor.set_scale(it.scale.value, it.scale.value);
            const r = onScreen ? Math.round(it.blurR.value) : 0;
            if (r !== it.lastBlur) {
                it.lastBlur = r;
                it.blur.radius = r;
                it.blur.enabled = r > 0;
            }
        }

        if (this._karaokeHost) {
            this._updateKaraoke(t);
            if (this._state.playing)
                moving = true;
        }
        if (this._autoPlain && this._kind === 'plain' && this._state.playing)
            moving = true;
        return moving;
    }

    // ── Interaction ─────────────────────────────────────────────────────
    _onScroll(event) {
        if (!this._items.length)
            return Clutter.EVENT_PROPAGATE;
        let dy = 0;
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
                return Clutter.EVENT_STOP;
            dy = event.get_scroll_delta()[1] * 48;
        } else if (dir === Clutter.ScrollDirection.UP) {
            dy = -64;
        } else if (dir === Clutter.ScrollDirection.DOWN) {
            dy = 64;
        }
        const ys = this._baseYs();
        const total = ys[ys.length - 1] ?? 0;
        const [, h] = this.get_size();
        const base = this._targetScroll(ys) - this._userOffset.value;
        const target = clamp(this._userOffset.target + dy, -base - h * 0.3, total - base - h * 0.3);
        this._userOffset.target = target;
        this._lastUserScroll = GLib.get_monotonic_time() / 1e6;
        if (!this._userScrolling) {
            this._userScrolling = true;
            // While reading, release every line from the stagger.
            const now = this._lastUserScroll;
            this._items.forEach(it => (it.delayUntil = now));
            this._applyStates(false);
        }
        this._ticker.wake();
        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._settings.disconnect(this._settingsId);
        this._detachKaraoke();
        this._ticker.destroy();
    }
});
