// One motion vocabulary for the whole lock screen, so every piece moves
// alike: the same curves, the same timings, springs for anything that can
// be interrupted half way (the widget morph).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

export const Ease = {
    enter: Clutter.AnimationMode.EASE_OUT_QUINT, // things arriving
    exit: Clutter.AnimationMode.EASE_OUT_CUBIC,  // things leaving
    move: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
};

export const Dur = {
    fast: 180,
    base: 320,
    slow: 560,
};

export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = t => {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
};

function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

// Fade + scale an actor in or out; hides it at the end of a fade-out.
export function reveal(actor, show, {delay = 0, scale = 0.94, dy = 0} = {}) {
    if (!actor)
        return;
    actor.set_pivot_point(0.5, 0.5);
    if (show) {
        if (!actor.visible) {
            actor.opacity = 0;
            actor.set_scale(scale, scale);
            actor.translation_y = dy;
            actor.show();
        }
        actor.ease({opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0,
            duration: Dur.slow, delay, mode: Ease.enter});
    } else if (actor.visible) {
        actor.ease({opacity: 0, scale_x: scale, scale_y: scale, translation_y: dy,
            duration: Dur.base, delay, mode: Ease.exit,
            onStopped: finished => {
                if (finished)
                    actor.hide();
            }});
    }
}

// A critically-damped-ish spring: response in seconds, damping 1 = no bounce.
export class Spring {
    constructor(value = 0, {response = 0.42, damping = 0.86} = {}) {
        this.value = value;
        this.velocity = 0;
        this.target = value;
        const w = 2 * Math.PI / response;
        this._k = w * w;
        this._c = 2 * damping * w;
    }

    get settled() {
        return Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.01;
    }

    jump(v) {
        this.value = this.target = v;
        this.velocity = 0;
    }

    step(dt) {
        if (this.settled || !animationsEnabled()) {
            this.jump(this.target);
            return false;
        }
        let left = Math.min(dt, 0.05);
        while (left > 0) {
            const h = Math.min(1 / 240, left);
            const a = -this._k * (this.value - this.target) - this._c * this.velocity;
            this.velocity += a * h;
            this.value += this.velocity * h;
            left -= h;
        }
        return true;
    }
}

// Runs `fn(dt)` on `actor`'s frame clock until it returns false.
export class Driver {
    constructor(actor, fn) {
        this._actor = actor;
        this._fn = fn;
        this._timeline = null;
        actor.connect('destroy', () => this.stop());
    }

    start() {
        if (this._timeline?.is_playing())
            return;
        if (!this._timeline) {
            this._timeline = new Clutter.Timeline({actor: this._actor, duration: 1000, repeat_count: -1});
            this._timeline.connect('new-frame', () => {
                const now = GLib.get_monotonic_time();
                const dt = clamp((now - this._last) / 1e6, 0, 0.05);
                this._last = now;
                if (!this._fn(dt))
                    this._timeline.stop();
            });
        }
        this._last = GLib.get_monotonic_time();
        this._timeline.start();
        // Not on screen yet (no frame clock): settle on the next frame we get,
        // or right away if there won't be one.
        if (!this._actor.mapped) {
            for (let i = 0; i < 200 && this._fn(0.05); i++)
                ; // run to rest
        }
    }

    stop() {
        this._timeline?.stop();
        this._timeline = null;
    }
}
