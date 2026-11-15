// The music widget: Floww Music's player as a glass panel, in two shapes
// it morphs between.
//
//   full                                    compact (while unlocking)
//   ┌──────────────────────────────────┐    ┌───────────────────────────────────────┐
//   │ [art]  Title                   ▮▮│    │ [art] Title · Artist        ⏮  ⏯  ⏭  │
//   │        Artist                    │    └───────────────────────────────────────┘
//   │ ───────────●──────────           │
//   │   ⤮   ⏮   ⏯   ⏭   ↻   (spotify)  │
//   │  current lyric line…             │   (optional)
//   └──────────────────────────────────┘
//
// `morph` (0 = full, 1 = compact) is driven by a spring, so the panel can
// change its mind half way and never jumps. The panel's size is the blend
// of both shapes; the two layouts cross-fade inside it.
// Everything comes from Floww Music's `api`, so it shares one player
// connection, one lyrics cache and one clock with the rest of Floww.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Glass} from './glass.js';
import {Spring, Driver, lerp, clamp, smooth} from './motion.js';

export const WIDGET_WIDTH = 400;
export const COMPACT_WIDTH = 460;

// Holds the two layouts; its size is the morph between them.
const MorphBox = GObject.registerClass(
class FlowwLockMorphBox extends St.Widget {
    _init(full, compact) {
        super._init({x_expand: true, y_expand: true, clip_to_allocation: true});
        this.full = full;
        this.compact = compact;
        this.add_child(full);
        this.add_child(compact);
        this._m = 0;
        this._apply();
    }

    get morph() {
        return this._m;
    }

    set morph(m) {
        if (m === this._m)
            return;
        this._m = m;
        this._apply();
        this.queue_relayout();
    }

    _apply() {
        const m = clamp(this._m, 0, 1);
        // The outgoing layout leaves quickly; the incoming one waits until
        // the panel is mostly in shape. Never both at full strength.
        const fullA = 1 - smooth(m / 0.55);
        const compactA = smooth((m - 0.45) / 0.55);
        this.full.opacity = Math.round(255 * fullA);
        this.compact.opacity = Math.round(255 * compactA);
        this.full.visible = fullA > 0.002;
        this.compact.visible = compactA > 0.002;
        this.full.translation_y = Math.round(-10 * m);
        this.compact.translation_y = Math.round(8 * (1 - m));
    }

    _sizes(forWidth = -1) {
        const [, fw] = this.full.get_preferred_width(-1);
        const [, cw] = this.compact.get_preferred_width(-1);
        const [, fh] = this.full.get_preferred_height(fw);
        const [, ch] = this.compact.get_preferred_height(cw);
        return {fw, fh, cw, ch};
    }

    vfunc_get_preferred_width(_forHeight) {
        const {fw, cw} = this._sizes();
        const w = lerp(fw, cw, this._m);
        return [w, w];
    }

    vfunc_get_preferred_height(_forWidth) {
        const {fh, ch} = this._sizes();
        const h = lerp(fh, ch, this._m);
        return [h, h];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const W = box.get_width(), H = box.get_height();
        const {fw, fh, cw, ch} = this._sizes();
        // Full layout pinned to the top, compact centred: as the panel
        // shrinks it seems to fold up around the one-line player.
        const fx = Math.round((W - fw) / 2);
        this.full.allocate(new Clutter.ActorBox({x1: fx, y1: 0, x2: fx + fw, y2: fh}));
        const cx = Math.round((W - cw) / 2), cy = Math.round((H - ch) / 2);
        this.compact.allocate(new Clutter.ActorBox({x1: cx, y1: cy, x2: cx + cw, y2: cy + ch}));
    }
});

export const MusicWidget = GObject.registerClass({
    Signals: {'activate': {}, 'morph-changed': {}},
}, class FlowwLockMusicWidget extends Glass {
    _init(api, getBackdrop, settings) {
        super._init(getBackdrop, settings, {
            styleClass: 'floww-glass floww-music',
            reactive: true,
            getFill: () => api.createAmbient({styleClass: 'flow-ambient floww-ambient-fill', dim: 0.85}),
        });
        this._api = api;
        this._settings = settings;

        this._box = new MorphBox(this._buildFull(api), this._buildCompact(api));
        this.setChild(this._box);

        this._spring = new Spring(0, {response: 0.5, damping: 0.84});
        this._driver = new Driver(this, dt => {
            const moving = this._spring.step(dt);
            this._box.morph = this._spring.value;
            this.emit('morph-changed');
            return moving;
        });

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

        // Click anywhere but a control → immersive lyrics (full shape only).
        const click = new Clutter.ClickGesture();
        click.connect('may-recognize', () => this._spring.target < 0.5 && !this._pointerOnControl());
        click.connect('recognize', () => this.emit('activate'));
        this.add_action(click);

        this._sync(false);
        this._syncLyrics();
    }

    _buildFull(api) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'floww-music-content',
            width: WIDGET_WIDTH,
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
        return box;
    }

    _buildCompact(api) {
        const row = new St.BoxLayout({
            style_class: 'floww-music-compact',
            width: COMPACT_WIDTH,
        });
        const art = api.createArt({size: 36, radius: 8, pauseScale: 0.9, styleClass: 'flow-art floww-music-art-small'});
        art.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(art);
        this._line = api.createSwapLabel({styleClass: 'floww-music-line'});
        this._line.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(this._line);
        const controls = api.createControls({size: 16, playSize: 20,
            styleClass: 'flow-controls floww-music-compact-controls'});
        controls.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(controls);
        return row;
    }

    // 0 = full, 1 = compact.
    get morph() {
        return this._spring.value;
    }

    setCompact(compact, animate = true) {
        const target = compact ? 1 : 0;
        if (this._spring.target === target && (animate || this._spring.settled))
            return;
        this._spring.target = target;
        if (!animate) {
            this._spring.jump(target);
            this._box.morph = target;
            this.emit('morph-changed');
            return;
        }
        this._driver.start();
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
        const line = t ? [t.title, t.artist].filter(Boolean).join('  ·  ') : '';
        this._line.setText(line, animate);
        this._line.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }

    _syncLyrics() {
        const kind = this._api.state.lyrics.kind;
        const show = this._settings.get_boolean('widget-lyrics') &&
            (kind === 'synced' || kind === 'plain' || kind === 'loading');
        if (show === this._lyricsShown)
            return;
        this._lyricsShown = show;
        // Grow / shrink the panel smoothly instead of popping.
        this._lyrics.remove_all_transitions();
        if (show) {
            this._lyrics.set_height(0);
            this._lyrics.opacity = 0;
            this._lyrics.show();
            this._lyrics.ease({height: 96, opacity: 255, duration: 420,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        } else {
            this._lyrics.ease({height: 0, opacity: 0, duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => {
                    this._lyrics.hide();
                    this._lyrics.set_height(96);
                }});
        }
    }
});
