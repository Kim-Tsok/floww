// Glass panels in three materials (setting `glass-material`):
//   liquid    a blurred, tinted copy of the wallpaper behind the widget,
//             bent at the edges like a thick lens, with a specular rim
//   frosted   the same wallpaper, heavily frosted and flat: no lens, a
//             softer rim (macOS vibrancy)
//   gradient  no see-through: a moving colour gradient (the album colours
//             for the music widget), with the same rounded rim
//
// How it works: each Glass holds a clone of the lock wallpaper, offset so it
// lines up exactly with what's behind it. Shell's blur runs on that clone
// (ACTOR mode, so it works in an offscreen buffer), then GlassEffect masks it
// to a rounded rectangle and does the refraction + rim lighting.
// The backdrop is drawn a little larger than the widget (PAD) so the blur
// never darkens the edges.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';

const PAD = 48;

const DECL = `
uniform sampler2D tex;
uniform float tex_w;
uniform float tex_h;
uniform float pad;
uniform float radius;
uniform float bend;
uniform vec4 tint;
uniform float rim;

float flowwRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
`;

const CODE = `
vec2 size = vec2(max(tex_w, 1.0), max(tex_h, 1.0));
vec2 uv = cogl_tex_coord_in[0].xy;
vec2 px = uv * size;
vec2 halfInner = max(size * 0.5 - vec2(pad), vec2(1.0));
vec2 p = px - size * 0.5;
float r = min(radius, min(halfInner.x, halfInner.y));
float d = flowwRoundBox(p, halfInner, r);            // < 0 inside
float cover = clamp(0.5 - d, 0.0, 1.0);

// Surface normal from the distance field (points outwards).
vec2 e = vec2(1.0, 0.0);
vec2 n = vec2(flowwRoundBox(p + e.xy, halfInner, r) - flowwRoundBox(p - e.xy, halfInner, r),
              flowwRoundBox(p + e.yx, halfInner, r) - flowwRoundBox(p - e.yx, halfInner, r));
n = n / max(length(n), 0.0001);

// Lens: strongest right at the rim, gone a few bends in.
float band = max(bend * 2.2, 1.0);
float lens = pow(1.0 - clamp(-d / band, 0.0, 1.0), 2.2);
vec2 off = -n * lens * bend;

vec4 col = texture2D(tex, (px + off) / size);
// A touch of dispersion at the very edge.
col.r = texture2D(tex, (px + off * 1.12) / size).r;
col.b = texture2D(tex, (px + off * 0.88) / size).b;

// Tint (premultiplied) and a soft inner glow along the edge.
col.rgb = mix(col.rgb, tint.rgb * col.a, tint.a);
col.rgb += vec3(0.07 * lens) * col.a;

// Specular rim, lit from the top-left, with a fainter bounce bottom-right.
float ring = 1.0 - smoothstep(0.0, 1.8, -d);
float light = dot(-n, normalize(vec2(0.55, 1.0)));
float spec = ring * rim * (0.22 + 0.78 * abs(light));
col.rgb += vec3(spec) * col.a;

cogl_color_out = col * cover * cogl_color_in.a;
`;

export const GlassEffect = GObject.registerClass(
class FlowwLockGlassEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._loc = {};
        for (const n of ['tex_w', 'tex_h', 'pad', 'radius', 'bend', 'tint', 'rim'])
            this._loc[n] = this.get_uniform_location(n);
        this._vals = {};
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECL, CODE, false);
    }

    _set(name, values) {
        const key = values.join(',');
        if (this._vals[name] === key)
            return;
        this._vals[name] = key;
        this.set_uniform_float(this._loc[name], values.length, values);
        this.queue_repaint();
    }

    update({width, height, pad, radius, bend, tint, rim}) {
        this._set('tex_w', [width]);
        this._set('tex_h', [height]);
        this._set('pad', [pad]);
        this._set('radius', [radius]);
        this._set('bend', [bend]);
        this._set('tint', tint);
        this._set('rim', [rim]);
    }
});

// "rgba(255,255,255,0.12)" / "#rrggbb" → [r, g, b, a] in 0..1
export function parseColor(str) {
    const m = String(str).match(/rgba?\(([^)]+)\)/);
    if (m) {
        const p = m[1].split(',').map(v => Number(v.trim()));
        return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
    }
    const h = String(str).match(/^#([0-9a-f]{6})$/i);
    if (h) {
        const v = parseInt(h[1], 16);
        return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255, 1];
    }
    return [1, 1, 1, 0.12];
}

// A rounded glass panel. Put content in it with `glass.setChild(actor)`.
// `getBackdrop()` returns the wallpaper actor to look through (or null);
// `settings` is the Floww Lock GSettings.
export const Glass = GObject.registerClass(
class FlowwLockGlass extends St.Widget {
    _init(getBackdrop, settings, {styleClass = 'floww-glass', radius = null, reactive = false, getFill = null} = {}) {
        super._init({
            style_class: styleClass,
            layout_manager: new Clutter.BinLayout(),
            reactive,
            track_hover: reactive,
        });
        this._getBackdrop = getBackdrop;
        this._settings = settings;
        this._fixedRadius = radius;
        this._getFill = getFill;
        this._fill = null;

        // Backdrop: wallpaper clone, blurred, then shaped by GlassEffect.
        // Blur and glass live on separate actors: Shell's blur doesn't chain
        // with another offscreen effect on the same actor.
        this._bd = new Clutter.Actor({clip_to_allocation: true});
        this._blurHost = new Clutter.Actor({clip_to_allocation: true}); // keeps the blur small
        this._clone = new Clutter.Clone();
        this._blurHost.add_child(this._clone);
        this._bd.add_child(this._blurHost);
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1});
        this._blurHost.add_effect_with_name('floww-blur', this._blur);
        this._fx = new GlassEffect();
        this._bd.add_effect_with_name('floww-glass', this._fx);
        this.add_child(this._bd);

        this._child = null;
        this._settingsIds = ['glass-tint', 'glass-blur', 'glass-refraction', 'glass-radius', 'glass-material']
            .map(k => settings.connect(`changed::${k}`, () => this._syncLook()));
        this.connect('destroy', () => {
            this._settingsIds.forEach(id => settings.disconnect(id));
            if (this._laterId)
                global.compositor.get_laters().remove(this._laterId);
        });
        this.connect('notify::mapped', () => this.refreshBackdrop());
        this._syncLook();
    }

    get radius() {
        return this._fixedRadius ?? this._settings.get_int('glass-radius');
    }

    setChild(actor) {
        this._child?.destroy();
        this._child = actor;
        actor.x_expand = true;
        actor.y_expand = true;
        this.add_child(actor);
    }

    get material() {
        return this._settings.get_string('glass-material');
    }

    _syncLook() {
        const r = this.radius;
        const material = this.material;
        this.set_style(`border-radius: ${r}px;`);
        for (const m of ['liquid', 'frosted', 'gradient']) {
            if (m === material)
                this.add_style_class_name(`floww-${m}`);
            else
                this.remove_style_class_name(`floww-${m}`);
        }

        // Gradient: swap the wallpaper for a colour fill.
        const gradient = material === 'gradient';
        if (gradient && !this._fill) {
            this._fill = this._getFill?.() ??
                new St.Widget({style_class: 'floww-gradient-fill'});
            this._blurHost.add_child(this._fill);
        }
        this._fill?.set({visible: gradient});
        this._clone.visible = !gradient;

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let blur = this._settings.get_int('glass-blur');
        if (material === 'frosted')
            blur = Math.max(blur, 40);
        if (gradient)
            blur = 0;
        this._blur.radius = blur * scale;
        this._blur.enabled = blur > 0;
        this._updateShader();
        this.refreshBackdrop();
    }

    _updateShader() {
        // Allocation, not get_size(): that would ask for a preferred size
        // (and a theme node) before we're on stage.
        const w = this._lastW ?? 0, h = this._lastH ?? 0;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const material = this.material;
        const tint = parseColor(this._settings.get_string('glass-tint'));
        let bend = this._settings.get_int('glass-refraction') / 100 * 14 * scale;
        let rim = 0.55;
        if (material === 'frosted') {
            // Flat, milky pane: no lens, more tint, a hairline rim.
            bend = 0;
            rim = 0.28;
            tint[3] = Math.min(0.6, tint[3] + 0.1);
        } else if (material === 'gradient') {
            bend = 0;
            rim = 0.32;
            tint[3] = 0;
        }
        this._fx.update({
            width: w + PAD * 2,
            height: h + PAD * 2,
            pad: PAD,
            radius: this.radius * scale,
            bend,
            tint,
            rim,
        });
    }

    // Re-aim the wallpaper clone after the widget moved (call after layout).
    refreshBackdrop() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._aim();
            return GLib.SOURCE_REMOVE;
        });
    }

    _aim() {
        if (this.material === 'gradient') {
            this._clone.source = null;
            this._bd.visible = this.mapped;
            this._bd.queue_redraw();
            return;
        }
        const src = this._getBackdrop();
        if (!src || !this.mapped) {
            this._clone.source = null;
            this._bd.visible = false;
            return;
        }
        if (this._clone.source !== src)
            this._clone.source = src;
        this._bd.visible = true;
        // Where we are relative to the wallpaper, ignoring our own scale
        // animations (close enough while they run, exact at rest).
        const [ox, oy] = this.get_transformed_position();
        const [sx, sy] = src.get_transformed_position();
        const [sw, sh] = src.get_size();
        // Not laid out yet (first frame after being shown): try again.
        if (![ox, oy, sx, sy, sw, sh].every(Number.isFinite)) {
            this.refreshBackdrop();
            return;
        }
        this._clone.set_size(sw, sh);
        this._clone.set_position(Math.round(sx - ox + PAD), Math.round(sy - oy + PAD));
        this._bd.queue_redraw();
    }

    // Size comes from the content only; the wallpaper clone inside is
    // screen-sized and must not make the panel grow.
    vfunc_get_preferred_width(forHeight) {
        const node = this.get_theme_node();
        const [min, nat] = this._child?.get_preferred_width(node.adjust_for_height(forHeight)) ?? [0, 0];
        return node.adjust_preferred_width(min, nat);
    }

    vfunc_get_preferred_height(forWidth) {
        const node = this.get_theme_node();
        const [min, nat] = this._child?.get_preferred_height(node.adjust_for_width(forWidth)) ?? [0, 0];
        return node.adjust_preferred_height(min, nat);
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const w = box.get_width(), h = box.get_height();
        this._bd.allocate(new Clutter.ActorBox({x1: -PAD, y1: -PAD, x2: w + PAD, y2: h + PAD}));
        this._blurHost.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: w + PAD * 2, y2: h + PAD * 2}));
        if (this._fill?.visible)
            this._fill.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: w + PAD * 2, y2: h + PAD * 2}));
        if (w !== this._lastW || h !== this._lastH) {
            this._lastW = w;
            this._lastH = h;
            this._updateShader();
        }
        this.refreshBackdrop();
    }
});
