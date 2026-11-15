// Physically based springs + a per-actor frame ticker.
//
// Every positional motion in Flow goes through a Spring so that animations
// can be interrupted at any moment and keep their velocity (a fast skip
// mid-scroll never snaps). Springs are parameterised like SwiftUI/Apple:
// `response` (seconds for one oscillation) and `dampingRatio` (1 = no bounce).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

export const Presets = {
    // Lyric scroll: soft, slightly underdamped, the Apple Music "glide".
    lyric: {response: 0.72, dampingRatio: 0.86},
    // UI feedback (buttons, hover).
    snappy: {response: 0.28, dampingRatio: 0.82},
    // Expanding/collapsing surfaces (pill, cards).
    bouncy: {response: 0.5, dampingRatio: 0.7},
    // Slow ambient motions (fades, art).
    gentle: {response: 0.9, dampingRatio: 1.0},
    // Drag follow.
    drag: {response: 0.16, dampingRatio: 0.9},
};

const SUBSTEP = 1 / 240;

function animationsEnabled() {
    return St.Settings.get().enable_animations;
}

export class Spring {
    constructor(value = 0, preset = Presets.snappy, precision = 0.005) {
        this.value = value;
        this.velocity = 0;
        this._target = value;
        this.precision = precision;
        this.setPreset(preset);
    }

    setPreset({response, dampingRatio}) {
        const omega = (2 * Math.PI) / response;
        this._k = omega * omega;
        this._c = 2 * dampingRatio * omega;
    }

    get target() {
        return this._target;
    }

    set target(v) {
        this._target = v;
    }

    jump(v) {
        this.value = v;
        this._target = v;
        this.velocity = 0;
    }

    get settled() {
        return Math.abs(this.value - this._target) < this.precision &&
            Math.abs(this.velocity) < this.precision * 10;
    }

    // Advance by dt seconds. Returns true while still moving.
    step(dt) {
        if (this.settled) {
            this.value = this._target;
            this.velocity = 0;
            return false;
        }
        if (!animationsEnabled()) {
            this.jump(this._target);
            return false;
        }
        let remaining = Math.min(dt, 0.1);
        while (remaining > 0) {
            const h = Math.min(SUBSTEP, remaining);
            const accel = -this._k * (this.value - this._target) - this._c * this.velocity;
            this.velocity += accel * h;
            this.value += this.velocity * h;
            remaining -= h;
        }
        return !this.settled;
    }
}

// Drives callbacks on the frame clock of `actor`. Each callback receives
// (dt seconds, monotonic µs) and returns true to keep the ticker alive.
// The timeline stops by itself once every callback reports idle, so nothing
// ticks while the UI is static.
export class Ticker {
    constructor(actor) {
        this._actor = actor;
        this._callbacks = new Set();
        this._last = 0;
        this._lastFrame = 0;
        this._timeline = null;
        this._createTimeline();
        this._mapId = actor.connect('notify::mapped', () => {
            if (actor.mapped) {
                // A fresh timeline picks up the frame clock of wherever the
                // actor is shown now (monitor changes, lock screen fades…).
                this._createTimeline();
                this.wake();
            } else {
                this._timeline?.stop();
            }
        });
    }

    _createTimeline() {
        if (this._timeline) {
            this._timeline.stop();
            this._timeline.disconnect(this._frameId);
        }
        this._timeline = new Clutter.Timeline({actor: this._actor, duration: 1000, repeat_count: -1});
        this._frameId = this._timeline.connect('new-frame', () => this._frame());
    }

    add(fn) {
        this._callbacks.add(fn);
        this.wake();
        return fn;
    }

    remove(fn) {
        this._callbacks.delete(fn);
    }

    wake() {
        if (!this._timeline || !this._actor.mapped)
            return;
        const now = GLib.get_monotonic_time();
        if (this._timeline.is_playing()) {
            // Watchdog: a timeline stuck on a dead frame clock never ticks.
            if (now - this._lastFrame > 500_000 && now - this._startedAt > 500_000) {
                this._createTimeline();
            } else {
                return;
            }
        }
        this._last = now;
        this._startedAt = now;
        this._timeline.start();
    }

    _frame() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(Math.max((now - this._last) / 1e6, 0), 0.1);
        this._last = now;
        this._lastFrame = now;
        let alive = false;
        for (const fn of this._callbacks) {
            try {
                if (fn(dt, now))
                    alive = true;
            } catch (e) {
                logError(e, 'Flow ticker');
            }
        }
        if (!alive)
            this._timeline.stop();
    }

    destroy() {
        if (!this._timeline)
            return;
        this._timeline.stop();
        this._timeline.disconnect(this._frameId);
        this._actor.disconnect(this._mapId);
        this._timeline = null;
        this._callbacks.clear();
    }
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
export const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
