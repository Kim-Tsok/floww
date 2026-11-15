// Floating desktop card: lives with the wallpaper, so it sits under every
// window like a real desktop widget.
// Drag anywhere on it (outside buttons/lyrics) to move; it follows the
// pointer on a tight spring, lifts while held and settles inside the screen.

import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Spring, Ticker, Presets, clamp} from '../anim/spring.js';
import {PlayerCard} from './playerCard.js';

const MARGIN = 24;

export class DesktopWidget {
    constructor(state, settings) {
        this._state = state;
        this._settings = settings;
        this._visible = false;

        this.actor = new St.Widget({
            style_class: 'flow-desktop',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            opacity: 0,
            visible: false,
        });
        this._card = new PlayerCard(state, settings, 'widget');
        this.actor.add_child(this._card);

        // Inside the background group (top of it): always under windows and
        // untouched by mutter's window restacking.
        Main.layoutManager._backgroundGroup.add_child(this.actor);

        this._x = new Spring(0, Presets.drag, 0.1);
        this._y = new Spring(0, Presets.drag, 0.1);
        this._lift = new Spring(1, Presets.bouncy, 0.0005);
        this._show = new Spring(0, Presets.bouncy, 0.002);
        this._ticker = new Ticker(this.actor);
        this._ticker.add(dt => this._tick(dt));

        this._setupDrag();

        this._signals = [
            state.connect('availability', () => this._sync()),
            state.connect('playback', () => this._sync()),
        ];
        this._settingsIds = [
            settings.connect('changed::widget-hide-when-paused', () => this._sync()),
        ];
        this._overviewIds = [
            Main.overview.connect('showing', () => this._sync()),
            Main.overview.connect('hidden', () => this._sync()),
        ];
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._restorePosition(true));

        this._restorePosition(true);
        this._sync();
    }

    _workArea() {
        const idx = Main.layoutManager.primaryIndex;
        return Main.layoutManager.getWorkAreaForMonitor(idx);
    }

    _size() {
        const [, w] = this.actor.get_preferred_width(-1);
        const [, h] = this.actor.get_preferred_height(w);
        return [w, h];
    }

    _clampToScreen(x, y) {
        const wa = this._workArea();
        const [w, h] = this._size();
        return [
            clamp(x, wa.x + MARGIN, wa.x + wa.width - w - MARGIN),
            clamp(y, wa.y + MARGIN, wa.y + wa.height - h - MARGIN),
        ];
    }

    _restorePosition(instant) {
        let x = this._settings.get_int('widget-x');
        let y = this._settings.get_int('widget-y');
        if (x < 0 || y < 0) {
            const wa = this._workArea();
            const [w] = this._size();
            x = wa.x + wa.width - w - MARGIN * 2;
            y = wa.y + MARGIN * 2;
        }
        [x, y] = this._clampToScreen(x, y);
        if (instant) {
            this._x.jump(x);
            this._y.jump(y);
            this.actor.set_position(Math.round(x), Math.round(y));
        } else {
            this._x.target = x;
            this._y.target = y;
            this._ticker.wake();
        }
    }

    _setupDrag() {
        const pan = new Clutter.PanGesture();
        pan.set_begin_threshold(8);
        pan.connect('recognize', () => {
            this._dragStart = [this._x.value, this._y.value];
            this._dragging = true;
            this._lift.target = 1.035;
            this.actor.add_style_class_name('flow-desktop-dragging');
            this._ticker.wake();
        });
        pan.connect('pan-update', () => {
            const d = pan.get_accumulated_delta();
            this._x.target = this._dragStart[0] + d.x;
            this._y.target = this._dragStart[1] + d.y;
            this._ticker.wake();
        });
        const finish = () => {
            this._dragging = false;
            this._lift.target = 1;
            this.actor.remove_style_class_name('flow-desktop-dragging');
            const [x, y] = this._clampToScreen(this._x.target, this._y.target);
            this._x.target = x;
            this._y.target = y;
            this._settings.set_int('widget-x', Math.round(x));
            this._settings.set_int('widget-y', Math.round(y));
            this._ticker.wake();
        };
        pan.connect('end', finish);
        pan.connect('cancel', finish);
        this.actor.add_action(pan);
    }

    _sync() {
        const st = this._state;
        const want = st.available &&
            !Main.overview.visible && !Main.overview.animationInProgress &&
            !(this._settings.get_boolean('widget-hide-when-paused') && !st.playing);
        if (want === this._visible)
            return;
        this._visible = want;
        if (want) {
            this.actor.show();
            this._restorePosition(true);
        }
        this._show.target = want ? 1 : 0;
        this._ticker.wake();
    }

    _tick(dt) {
        let moving = false;
        for (const s of [this._x, this._y, this._lift, this._show]) {
            if (s.step(dt))
                moving = true;
        }
        this.actor.set_position(Math.round(this._x.value), Math.round(this._y.value));
        const show = clamp(this._show.value, 0, 1.2);
        const scale = this._lift.value * (0.92 + 0.08 * show);
        this.actor.set_scale(scale, scale);
        this.actor.opacity = Math.round(255 * clamp(show, 0, 1));
        if (!this._visible && show < 0.01 && !moving)
            this.actor.hide();
        return moving || this._dragging;
    }

    destroy() {
        this._signals.forEach(id => this._state.disconnect(id));
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._overviewIds.forEach(id => Main.overview.disconnect(id));
        Main.layoutManager.disconnect(this._monitorsId);
        this._ticker.destroy();
        this.actor.destroy();
    }
}
