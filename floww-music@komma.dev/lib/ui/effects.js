// GPU effects: karaoke fill, edge fade mask, and the ambient mesh gradient.

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// ── Karaoke fill ────────────────────────────────────────────────────────
// Lights up a wrapped text label row by row; inside the current row a soft
// edge sweeps left→right. Unlit text is dimmed to the same level inactive
// lines use, so a line becoming active is visually seamless.
const KARAOKE_DECL = `
uniform float fill_row;
uniform float fill_x;
uniform float n_rows;
uniform float feather;
uniform float dim;
`;

const KARAOKE_CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
float row = floor(clamp(uv.y, 0.0, 0.9999) * n_rows);
float lit = 0.0;
if (row < fill_row)
    lit = 1.0;
else if (row == fill_row)
    lit = 1.0 - smoothstep(fill_x - feather, fill_x + feather, uv.x);
cogl_color_out *= mix(dim, 1.0, lit);
`;

export const KaraokeEffect = GObject.registerClass(
class FlowwMusicKaraokeEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._loc = {
            row: this.get_uniform_location('fill_row'),
            x: this.get_uniform_location('fill_x'),
            rows: this.get_uniform_location('n_rows'),
            feather: this.get_uniform_location('feather'),
            dim: this.get_uniform_location('dim'),
        };
        this._last = '';
        this.setFill(0, 0, 1, 0.05, 0.4);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, KARAOKE_DECL, KARAOKE_CODE, false);
    }

    setFill(row, x, rows, feather, dim) {
        const key = `${row}|${x.toFixed(4)}|${rows}|${feather.toFixed(4)}|${dim.toFixed(3)}`;
        if (key === this._last)
            return;
        this._last = key;
        this.set_uniform_float(this._loc.row, 1, [row]);
        this.set_uniform_float(this._loc.x, 1, [x]);
        this.set_uniform_float(this._loc.rows, 1, [rows]);
        this.set_uniform_float(this._loc.feather, 1, [feather]);
        this.set_uniform_float(this._loc.dim, 1, [dim]);
        this.queue_repaint();
    }
});

// ── Edge fade ───────────────────────────────────────────────────────────
const FADE_DECL = `
uniform float fade_top;
uniform float fade_bottom;
`;

const FADE_CODE = `
float y = cogl_tex_coord_in[0].y;
float a = smoothstep(0.0, fade_top, y) * (1.0 - smoothstep(1.0 - fade_bottom, 1.0, y));
cogl_color_out *= a;
`;

export const FadeEffect = GObject.registerClass(
class FlowwMusicFadeEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._top = this.get_uniform_location('fade_top');
        this._bottom = this.get_uniform_location('fade_bottom');
        this.setFade(0.12, 0.2);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, FADE_DECL, FADE_CODE, false);
    }

    setFade(top, bottom) {
        this.set_uniform_float(this._top, 1, [Math.max(top, 0.0001)]);
        this.set_uniform_float(this._bottom, 1, [Math.max(bottom, 0.0001)]);
        this.queue_repaint();
    }
});

// ── Ambient mesh gradient ───────────────────────────────────────────────
// Four soft colour blobs drifting on slow Lissajous paths with a gentle
// domain warp — the "living album art" backdrop. Output alpha follows the
// actor's own (rounded) shape, so border-radius still clips it.
const AMBIENT_DECL = `
uniform vec3 c0;
uniform vec3 c1;
uniform vec3 c2;
uniform vec3 c3;
uniform float u_time;
uniform float u_aspect;
uniform float u_dim;
float flow_hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`;

const AMBIENT_CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
float t = u_time;
vec2 p = vec2(uv.x * u_aspect, uv.y);
p += 0.09 * vec2(sin(p.y * 2.7 + t * 0.37), cos(p.x * 2.3 - t * 0.31));
vec2 q0 = vec2((0.22 + 0.18 * sin(t * 0.21)) * u_aspect, 0.28 + 0.22 * cos(t * 0.17));
vec2 q1 = vec2((0.78 + 0.16 * cos(t * 0.15 + 1.3)) * u_aspect, 0.22 + 0.20 * sin(t * 0.26));
vec2 q2 = vec2((0.30 + 0.22 * cos(t * 0.19 + 2.1)) * u_aspect, 0.82 + 0.14 * sin(t * 0.12));
vec2 q3 = vec2((0.80 + 0.14 * sin(t * 0.24 + 0.7)) * u_aspect, 0.74 + 0.20 * cos(t * 0.20));
float k = 3.2 / max(u_aspect, 1.0);
float w0 = exp(-k * dot(p - q0, p - q0) * 2.0);
float w1 = exp(-k * dot(p - q1, p - q1) * 2.0);
float w2 = exp(-k * dot(p - q2, p - q2) * 2.0);
float w3 = exp(-k * dot(p - q3, p - q3) * 2.0);
vec3 col = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / (w0 + w1 + w2 + w3 + 0.0001);
col *= u_dim;
col += (flow_hash(uv * 977.0 + t) - 0.5) / 255.0;
float a = cogl_color_out.a;
cogl_color_out = vec4(col * a, a);
`;

export const AmbientEffect = GObject.registerClass(
class FlowwMusicAmbientEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._loc = ['c0', 'c1', 'c2', 'c3'].map(n => this.get_uniform_location(n));
        this._time = this.get_uniform_location('u_time');
        this._aspect = this.get_uniform_location('u_aspect');
        this._dim = this.get_uniform_location('u_dim');
        this.set_uniform_float(this._aspect, 1, [1]);
        this.set_uniform_float(this._dim, 1, [1]);
        this.set_uniform_float(this._time, 1, [0]);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, AMBIENT_DECL, AMBIENT_CODE, false);
    }

    setColors(colors) {
        colors.forEach((c, i) => this.set_uniform_float(this._loc[i], 3, c));
        this.queue_repaint();
    }

    setTime(t) {
        this.set_uniform_float(this._time, 1, [t]);
        this.queue_repaint();
    }

    setAspect(a) {
        this.set_uniform_float(this._aspect, 1, [a]);
        this.queue_repaint();
    }

    setDim(d) {
        this.set_uniform_float(this._dim, 1, [d]);
        this.queue_repaint();
    }
});
