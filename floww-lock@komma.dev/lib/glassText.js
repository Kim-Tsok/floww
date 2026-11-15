// Liquid-glass lettering for the clock (iOS 26 style): the digits become
// clear glass. The body is only faintly frosted so the wallpaper shows
// through, the edges catch a bright specular highlight from the top-left,
// a softer bounce light sits on the bottom-right, and the inside of each
// stroke is shaded like thick glass (lit band near the lit edge, a faint
// shadow near the other).
//
// Works purely from the label's own alpha: the edge normal is the alpha
// gradient. Apply it to a label drawn in opaque white with no text-shadow.

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

const DECL = `
uniform sampler2D tex;
uniform vec2 texel;
uniform float body;
uniform float shine;
`;

const CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
float a = texture2D(tex, uv).a;

// Edge normal from the alpha gradient (points into the glyph).
vec2 r1 = texel * 1.5;
vec2 g = vec2(texture2D(tex, uv + vec2(r1.x, 0.0)).a - texture2D(tex, uv - vec2(r1.x, 0.0)).a,
              texture2D(tex, uv + vec2(0.0, r1.y)).a - texture2D(tex, uv - vec2(0.0, r1.y)).a);
float edge = clamp(length(g) * 1.4, 0.0, 1.0);
vec2 n = g / max(length(g), 0.0001);

// Light from the top-left; the outward normal is -n.
vec2 L = normalize(vec2(-0.55, -1.0));
float facing = dot(-n, L);
float spec = edge * (0.08 + 0.92 * pow(max(facing, 0.0), 1.4));
float bounce = edge * max(-facing, 0.0) * 0.22;

// Thick-glass shading: a lit band just inside the edges that face the
// light, a faint shadow inside the ones that face away.
vec2 r3 = texel * 5.0;
float innerLit = a * (1.0 - texture2D(tex, uv + L * r3).a);
float innerShadow = a * (1.0 - texture2D(tex, uv - L * r3).a);

float light = a * body + a * (spec + bounce) * shine + innerLit * 0.32;
float shade = innerShadow * 0.16;
light = clamp(light, 0.0, 1.0);
float alpha = clamp(light + shade, 0.0, 1.0);
cogl_color_out = vec4(vec3(light), alpha) * cogl_color_in.a;
`;

export const GlassTextEffect = GObject.registerClass(
class FlowwLockGlassTextEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._loc = {
            texel: this.get_uniform_location('texel'),
            body: this.get_uniform_location('body'),
            shine: this.get_uniform_location('shine'),
        };
        this._key = '';
        this.setParams({width: 100, height: 100, body: 0.16, shine: 1});
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECL, CODE, false);
    }

    // width/height: the label's size in device pixels.
    setParams({width, height, body = 0.16, shine = 1}) {
        const key = `${width}|${height}|${body}|${shine}`;
        if (key === this._key)
            return;
        this._key = key;
        this.set_uniform_float(this._loc.texel, 2, [1 / Math.max(1, width), 1 / Math.max(1, height)]);
        this.set_uniform_float(this._loc.body, 1, [body]);
        this.set_uniform_float(this._loc.shine, 1, [shine]);
        this.queue_repaint();
    }
});
