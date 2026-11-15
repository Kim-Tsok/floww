// Replaces the layout manager of GNOME's unlock dialog content box.
// It only decides *where* things go; GNOME still owns the password prompt,
// authentication and the clock ⇄ prompt transition.
//
// Default arrangement (macOS / iOS):
//
//            Saturday, November 15
//                   9:41
//             [ 🔔 3 notifications ]
//
//
//          ┌──────── music ────────┐
//          └───────────────────────┘
//        Click or press a key to unlock
//
// While the password prompt is up, the music widget folds into a one-line
// player at the bottom and the prompt sits right above it. Everything is a
// continuous function of the prompt progress and the widget's morph, so
// nothing ever jumps.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {lerp} from './motion.js';

const MARGIN = 56;
const GAP = 28;

function place(actor, x, y, w, h) {
    if (![x, y, w, h].every(Number.isFinite)) {
        console.warn(`Floww Lock: bad box for ${actor.constructor.name}: ${[x, y, w, h]}`);
        x = y = w = h = 0;
    }
    actor.allocate(new Clutter.ActorBox({
        x1: Math.round(x), y1: Math.round(y),
        x2: Math.round(x + w), y2: Math.round(y + h),
    }));
}

function natural(actor, forWidth = -1) {
    if (!actor || !actor.visible)
        return [0, 0];
    const [, w] = actor.get_preferred_width(-1);
    const ww = forWidth > 0 ? Math.min(w, forWidth) : w;
    const [, h] = actor.get_preferred_height(ww);
    return [ww, h];
}

export const FlowwLockLayout = GObject.registerClass(
class FlowwLockLayout extends Clutter.LayoutManager {
    _init(items, settings) {
        super._init();
        // {stack, hint, notifications, userButton, clock, music, count, immersive, adjustment}
        this._i = items;
        this._settings = settings;
        this.notifMode = settings.get_string('notifications-mode'); // full | count | hidden
    }

    vfunc_get_preferred_width(container, forHeight) {
        return this._i.stack.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(container, forWidth) {
        return this._i.stack.get_preferred_height(forWidth);
    }

    vfunc_allocate(container, box) {
        const s = this._settings;
        const [W, H] = box.get_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const M = MARGIN * scale, G = GAP * scale;
        const {stack, hint, notifications, userButton, clock, music, count, immersive, adjustment} = this._i;
        const p = Math.min(1, Math.max(0, adjustment?.value ?? 0)); // 0 clock … 1 prompt

        const wpos = s.get_string('widget-position');
        const musicOn = !!music?.visible && wpos !== 'hidden';
        const m = musicOn ? music.morph : 0; // 0 full … 1 compact
        const compactOn = musicOn && s.get_boolean('widget-compact');
        const promptBottom = s.get_string('prompt-position') === 'bottom';

        // ── Music widget size + its compact slot (bottom centre) ───────
        const [mw, mh] = musicOn ? natural(music) : [0, 0];
        const bottomPad = M * 0.55;
        const compactBox = {x: (W - mw) / 2, y: H - bottomPad - mh};

        // ── Hint ("click or press a key") and password prompt ──────────
        // The hint (ours; GNOME's is kept invisible) sits at the very
        // bottom. The prompt rises from there to just above the compact
        // player (or to the upper third in GNOME's position).
        const [hw, hh] = natural(hint);
        const hintBottom = H - M * 0.4;
        if (hint)
            place(hint, (W - hw) / 2, hintBottom - hh, hw, hh);
        const [stackW, stackH] = natural(stack);
        let promptY;
        if (!promptBottom)
            promptY = Math.round(H / 3);
        else if (compactOn)
            promptY = compactBox.y - G * 0.9 - stackH;
        else
            promptY = H - stackH - M * 0.6;
        const stackY = lerp(Math.max(promptY, hintBottom - stackH), promptY, p);
        place(stack, (W - stackW) / 2, stackY, stackW, stackH);

        // Space left at the bottom for everything else.
        const bottomTop = Math.min(
            hintBottom - hh - G * 0.6,
            p > 0 && !compactOn ? stackY - G * 0.6 : Infinity);

        // ── Clock ───────────────────────────────────────────────────────
        const cpos = s.get_string('clock-position');
        const [cw, ch] = natural(clock);
        const top = Math.max(M * 1.5, H * 0.085);
        let cx = (W - cw) / 2, cy = top;
        if (cpos.endsWith('left'))
            cx = M;
        else if (cpos.endsWith('right'))
            cx = W - cw - M;
        if (cpos === 'center')
            cy = (H - ch) / 2 - H * 0.1;
        else if (cpos.startsWith('bottom'))
            cy = bottomTop - ch - (musicOn && wpos === 'bottom-center' ? mh + G : 0);
        if (clock)
            place(clock, cx, cy, cw, ch);
        const alignX = w => (cpos.endsWith('left') ? cx
            : cpos.endsWith('right') ? cx + cw - w : (W - w) / 2);
        let underClock = cy + ch + G * 0.55; // next free spot under the clock

        // ── Notification count pill (under the clock by default) ───────
        const mode = this.notifMode;
        const npos = s.get_string('notifications-position');
        const colW = Math.max(stackW, 400 * scale);
        if (count) {
            const [pw, ph] = natural(count);
            if (mode === 'count' && count.visible) {
                let px = alignX(pw), py = underClock;
                if (npos === 'right' || npos === 'left') {
                    px = npos === 'right' ? W - pw - M : M;
                    py = (H - ph) / 2;
                } else if (npos === 'bottom') {
                    py = bottomTop - ph - (musicOn && wpos === 'bottom-center' ? mh + G : 0);
                }
                place(count, px, py, pw, ph);
                if (npos === 'below-clock')
                    underClock = py + ph + G;
            } else {
                place(count, alignX(pw), underClock, pw, ph);
            }
        }

        // ── Music widget (full position ↔ compact slot) ────────────────
        let mBox = null;
        if (music) {
            let fx, fy;
            switch (wpos) {
            case 'left':
                fx = M; fy = (H - mh) / 2;
                break;
            case 'right':
                fx = W - mw - M; fy = (H - mh) / 2;
                break;
            case 'bottom-left':
                fx = M; fy = bottomTop - mh;
                break;
            case 'bottom-right':
                fx = W - mw - M; fy = bottomTop - mh;
                break;
            case 'below-clock':
                fx = alignX(mw);
                fy = cpos.startsWith('bottom') ? cy - G - mh : underClock;
                break;
            default: // bottom-center
                fx = (W - mw) / 2; fy = bottomTop - mh;
            }
            if (!musicOn) {
                place(music, fx ?? 0, fy ?? 0, mw, mh);
            } else {
                fy = Math.max(M * 0.5, fy);
                const k = compactOn ? Math.min(1.05, Math.max(-0.05, m)) : 0;
                const x = lerp(fx, compactBox.x, k), y = lerp(fy, compactBox.y, k);
                place(music, x, y, mw, mh);
                mBox = {x: fx, y: fy, w: mw, h: mh};
                if (wpos === 'below-clock')
                    underClock = fy + mh + G;
            }
        }

        // ── Notification list ───────────────────────────────────────────
        const floor = Math.min(bottomTop,
            mBox && wpos === 'bottom-center' ? mBox.y - G : Infinity,
            p > 0 ? stackY - G * 0.6 : Infinity);
        if (mode !== 'full') {
            place(notifications, 0, 0, 0, 0);
        } else {
            let [, nh] = natural(notifications, colW);
            const nw = colW;
            let nx = (W - nw) / 2, ny, maxH;
            if (npos === 'right' || npos === 'left') {
                nx = npos === 'right' ? W - nw - M : M;
                maxH = floor - M * 2;
                nh = Math.min(nh, maxH);
                ny = (H - nh) / 2;
            } else if (npos === 'bottom') {
                maxH = Math.max(0, floor - H * 0.35);
                nh = Math.min(nh, maxH);
                ny = floor - nh;
            } else { // below-clock / below-widget
                const startY = npos === 'below-widget' && mBox && wpos !== 'bottom-center'
                    ? mBox.y + mBox.h + G : underClock;
                maxH = Math.max(0, floor - startY);
                nh = Math.min(nh, maxH);
                ny = startY;
            }
            // No room: tuck it away rather than show a sliver with a scrollbar.
            if (nh < 64 * scale)
                place(notifications, 0, 0, 0, 0);
            else
                place(notifications, nx, ny, nw, nh);
        }

        // ── Switch-user button (GNOME's spot) ───────────────────────────
        if (userButton?.visible) {
            const [uw, uh] = natural(userButton);
            place(userButton, W - uw - M * 0.5, H - uh - M * 0.4, uw, uh);
        } else if (userButton) {
            place(userButton, 0, 0, 0, 0);
        }

        if (immersive)
            place(immersive, 0, 0, W, H);
    }
});
