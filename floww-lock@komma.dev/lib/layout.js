// Replaces the layout manager of GNOME's unlock dialog content box.
// It only decides *where* things go; GNOME still owns the password prompt,
// authentication and the clock ⇄ prompt transition.
//
// Items: GNOME's stack (password prompt + "click to unlock" hint), GNOME's
// notification list, the switch-user button, and ours: clock, music widget,
// notification count pill, immersive lyrics layer.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

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
        this._i = items; // {stack, notifications, userButton, clock, music, count, immersive}
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
        const {stack, notifications, userButton, clock, music, count, immersive} = this._i;

        // ── Password prompt / hint ─────────────────────────────────────
        const [stackW, stackH] = natural(stack);
        const promptBottom = s.get_string('prompt-position') === 'bottom';
        const stackY = promptBottom ? H - stackH - M * 0.6 : Math.round(H / 3);
        place(stack, (W - stackW) / 2, stackY, stackW, stackH);
        const floor = promptBottom ? stackY - G : H - M; // nothing goes below this

        // ── Clock ───────────────────────────────────────────────────────
        const cpos = s.get_string('clock-position');
        const [cw, ch] = natural(clock);
        let cx = (W - cw) / 2, cy = M * 1.1;
        if (cpos.endsWith('left'))
            cx = M;
        else if (cpos.endsWith('right'))
            cx = W - cw - M;
        if (cpos === 'center')
            cy = (H - ch) / 2 - H * 0.08;
        else if (cpos.startsWith('bottom'))
            cy = floor - ch;
        if (clock)
            place(clock, cx, cy, cw, ch);

        // ── Music widget ────────────────────────────────────────────────
        const wpos = s.get_string('widget-position');
        let mBox = null;
        if (music) {
            const [mw, mh] = natural(music);
            let mx, my;
            switch (wpos) {
            case 'left':
                mx = M; my = (H - mh) / 2;
                break;
            case 'right':
                mx = W - mw - M; my = (H - mh) / 2;
                break;
            case 'bottom-left':
                mx = M; my = floor - mh;
                break;
            case 'bottom-right':
                mx = W - mw - M; my = floor - mh;
                break;
            default: { // below-clock, aligned like the clock
                mx = cpos.endsWith('left') ? cx
                    : cpos.endsWith('right') ? cx + cw - mw : (W - mw) / 2;
                my = cpos.startsWith('bottom') ? cy - G - mh : cy + ch + G;
            }
            }
            if (wpos === 'hidden') {
                place(music, 0, 0, 0, 0);
            } else {
                my = Math.max(M * 0.5, Math.min(my, floor - mh));
                place(music, mx, my, mw, mh);
                mBox = {x: mx, y: my, w: mw, h: mh};
            }
        }

        // ── Notifications (full list or count pill) ─────────────────────
        const mode = this.notifMode;
        const npos = s.get_string('notifications-position');
        const colW = Math.max(stackW, 400 * scale);
        const target = mode === 'hidden' ? null : mode === 'count' ? count : notifications;
        const other = mode === 'count' ? notifications : count;
        if (mode === 'hidden')
            place(notifications, 0, 0, 0, 0);
        if (other)
            place(other, 0, 0, 0, 0);
        if (target) {
            let [nw, nh] = natural(target, colW);
            if (target === notifications)
                nw = colW;
            let nx = (W - nw) / 2, ny, maxH;
            if (npos === 'right' || npos === 'left') {
                nx = npos === 'right' ? W - nw - M : M;
                maxH = floor - M * 2;
                nh = Math.min(nh, maxH);
                ny = (H - nh) / 2;
            } else if (npos === 'below-widget') {
                const top = mBox && wpos === 'below-clock'
                    ? mBox.y + mBox.h + G
                    : cpos === 'top' ? cy + ch + G : H * 0.45;
                maxH = Math.max(0, floor - top);
                nh = Math.min(nh, maxH);
                ny = top;
            } else { // bottom: grows upwards from the prompt / screen edge
                maxH = Math.max(0, floor - H * 0.35);
                nh = Math.min(nh, maxH);
                ny = floor - nh;
            }
            // No room (e.g. the prompt is up below the widgets): tuck it
            // away rather than show a sliver with a scrollbar.
            if (nh < 64 * scale && target === notifications)
                place(target, 0, 0, 0, 0);
            else
                place(target, nx, ny, nw, nh);
        }

        // ── Switch-user button (GNOME's spot) ───────────────────────────
        if (userButton?.visible) {
            const [uw, uh] = natural(userButton);
            place(userButton, W - uw * 2, H - uh * 2, uw, uh);
        } else if (userButton) {
            place(userButton, 0, 0, 0, 0);
        }

        if (immersive)
            place(immersive, 0, 0, W, H);
    }
});
