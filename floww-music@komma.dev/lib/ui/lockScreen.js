// Lock screen: a frosted card under the clock that expands, on click, into
// full-screen immersive lyrics over the living album-art gradient.
//
// Safety rules: everything here is optional decoration on top of GNOME's
// UnlockDialog. We never take key focus, any key still goes straight to the
// password prompt, and if the dialog's internals ever change we simply don't
// attach (no lock UI is better than a broken lock).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';

import {Spring, Ticker, Presets, clamp} from '../anim/spring.js';
import {PlayerCard} from './playerCard.js';
import {makeImmersive, pointerOnControl} from './immersive.js';

const CARD_GAP = 36;

// Fullscreen container that places the card right under GNOME's clock at
// allocation time (after the dialog has laid out its own clock), and lets
// the immersive layer fill the monitor.
const LockRoot = GObject.registerClass(
class FlowwMusicLockRoot extends St.Widget {
    _init(dialog) {
        super._init({reactive: false});
        this._dialog = dialog;
        this.card = null;
        this.immersive = null;
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [w, h] = box.get_size();
        if (this.immersive) {
            const full = new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h});
            this.immersive.allocate(full);
        }
        if (this.card && this.card.get_parent() === this) {
            // Fallback placement (notification list unavailable): under the
            // clock, but never over the notifications.
            const notifBox = this._dialog._notificationsBox?.get_allocation_box();
            const stackBox = this._dialog._stack.get_allocation_box();
            const clockBox = this._dialog._clock.get_allocation_box();
            const [, natW] = this.card.get_preferred_width(-1);
            const [, natH] = this.card.get_preferred_height(natW);
            const x = Math.round((w - natW) / 2);
            let maxY = h - natH - 24;
            if (notifBox && this._dialog._notificationsBox.visible && notifBox.get_height() > 0)
                maxY = Math.min(maxY, notifBox.y1 - natH - 12);
            const y = Math.round(Math.max(0, Math.min(stackBox.y1 + clockBox.y2 + CARD_GAP, maxY)));
            this.card.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + natW, y2: y + natH}));
        }
    }
});

export class LockScreenUI {
    constructor(state, settings) {
        this._state = state;
        this._settings = settings;
        this._dialog = null;
        this._tries = 0;
        this._tryAttach();
    }

    _tryAttach() {
        const dialog = Main.screenShield?._dialog;
        if (dialog && dialog._clock && dialog._stack && dialog._adjustment) {
            try {
                this._attach(dialog);
            } catch (e) {
                logError(e, 'Floww Music: lock screen attach failed');
                this._detach();
            }
            return;
        }
        if (this._tries++ > 20)
            return;
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._retryId = 0;
            this._tryAttach();
            return GLib.SOURCE_REMOVE;
        });
    }

    _attach(dialog) {
        this._dialog = dialog;
        this._immersiveOn = false;

        this._root = new LockRoot(dialog);
        this._root.add_constraint(new Layout.MonitorConstraint({primary: true}));
        dialog.add_child(this._root);

        // Card: lives at the top of GNOME's notification list (where its
        // own media card goes), so GNOME's layout stacks notifications under
        // it and moves the clock up as needed: no overlap.
        this._card = new PlayerCard(this._state, this._settings, 'lock');
        this._card.set_pivot_point(0.5, 0.5);
        this._card.add_style_class_name('flow-card-clickable');
        const list = dialog._notificationsBox?._notificationBox;
        if (list instanceof St.BoxLayout) {
            this._card.add_style_class_name('flow-card-in-list');
            // Match the notification column instead of forcing our width
            // (the column is narrower than the standalone card and clips).
            this._card.set_width(-1);
            this._card.x_expand = true;
            this._card.x_align = Clutter.ActorAlign.FILL;
            list.insert_child_at_index(this._card, 0);
            this._inList = true;
            this._card.connect('destroy', () => {
                this._inList = false;
                this._cardVisId = 0;
                this._listId = 0; // list goes away with the dialog
            });
            this._cardVisId = this._card.connect('notify::visible', () => this._refreshNotifications());
            // GNOME inserts players at 0 and sources after them; keep the
            // music card first.
            this._list = list;
            this._listId = list.connect('child-added', () => {
                if (list.get_child_at_index(0) !== this._card)
                    list.set_child_at_index(this._card, 0);
            });
        } else {
            this._root.add_child(this._card);
        }
        this._root.card = this._card;
        const click = new Clutter.ClickGesture();
        click.connect('may-recognize', () => !pointerOnControl(this._card));
        click.connect('recognize', () => this._setImmersive(true));
        this._card.add_action(click);

        // Immersive layer: grows out of the card, shrinks back into it.
        this._immersive = makeImmersive(this._state, this._settings, {clock: true});
        this._root.add_child(this._immersive);
        this._root.immersive = this._immersive;
        this._immersive.connect('close-request', () => this._setImmersive(false));
        this._imP = 0;
        this._immersive.connect('progress', (v, p) => {
            this._imP = p;
            this._applyCard();
        });

        this._presence = new Spring(this._state.available ? 1 : 0, Presets.bouncy, 0.002);
        this._ticker = new Ticker(this._root);
        this._ticker.add(dt => this._tick(dt));

        // Keep our clicks from also summoning the password prompt.
        this._gestureIds = [];
        for (const action of dialog.get_actions()) {
            if (action instanceof Clutter.ClickGesture) {
                const id = action.connect('may-recognize', () =>
                    !(this._card.hover || (this._immersive.visible && this._immersive.hover)));
                this._gestureIds.push([action, id]);
            }
        }

        // Follow the clock → prompt transition (fade with GNOME's own).
        this._adjId = dialog._adjustment.connect('notify::value', () => this._onPromptProgress());

        this._stateIds = [
            this._state.connect('availability', () => {
                this._presence.target = this._state.available ? 1 : 0;
                if (!this._state.available)
                    this._setImmersive(false);
                this._ticker.wake();
            }),
        ];

        this._hideSystemPlayer(true);
        this._refreshNotifications();
        this._onPromptProgress();
        this._ticker.wake();
    }

    // NotificationsBox hides itself when it thinks it's empty; tell it to
    // re-check now that our card is (or isn't) one of its children.
    _refreshNotifications() {
        try {
            this._dialog?._notificationsBox?._updateVisibility?.();
        } catch (e) {
            console.debug(`Floww Music: notification box refresh failed: ${e.message}`);
        }
    }

    // GNOME already shows a small media card in the notifications area; with
    // Flow's richer card on screen, hide the one for the player we follow.
    _hideSystemPlayer(hide) {
        try {
            if (!this._settings.get_boolean('lock-hide-system-player') && hide)
                return;
            const players = this._dialog?._notificationsBox?._players;
            if (!players)
                return;
            for (const [player, message] of players) {
                const ours = !!player?._busName && player._busName === this._state.track?.busName;
                message.visible = !(hide && ours);
            }
            if (hide && !this._hideTimer) {
                // Players can appear late; re-apply a few times.
                let n = 0;
                this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                    this._hideSystemPlayer(true);
                    return ++n < 10 ? GLib.SOURCE_CONTINUE : (this._hideTimer = 0, GLib.SOURCE_REMOVE);
                });
            }
        } catch (e) {
            console.debug(`Floww Music: could not hide system player: ${e.message}`);
        }
    }

    _onPromptProgress() {
        const p = this._dialog._adjustment.value;
        if (p > 0 && this._immersiveOn)
            this._setImmersive(false, true);
        this._root.opacity = Math.round(255 * (1 - p));
        this._root.visible = p < 1;
        this._root.translation_y = -60 * p;
    }

    _setImmersive(on, byPrompt = false) {
        if (on && !this._state.available)
            on = false;
        if (on === this._immersiveOn)
            return;
        this._immersiveOn = on;
        if (on)
            this._immersive.present(this._card);
        else if (byPrompt)
            this._immersive.hideNow();
        else
            this._immersive.dismiss(this._card.visible ? this._card : null);
        // The clock and notifications politely step aside.
        const others = [this._dialog._clock, this._dialog._notificationsBox].filter(Boolean);
        for (const a of others) {
            if (byPrompt) {
                // GNOME is animating the clock itself now; don't fight it.
                a.remove_all_transitions();
                if (a !== this._dialog._clock)
                    a.opacity = 255;
                continue;
            }
            a.ease({opacity: on ? 0 : 255, duration: on ? 260 : 420,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._ticker.wake();
    }

    _tick(dt) {
        const moving = this._presence.step(dt);
        this._applyCard();
        return moving;
    }

    // The card hands over to the immersive view: it swells a little and
    // dissolves in the first third of the expansion, so the gradient
    // growing out of it reads as the card itself opening up.
    _applyCard() {
        const m = clamp(this._imP ?? 0, 0, 1);
        const pres = clamp(this._presence.value, 0, 1.2);
        const cs = (0.9 + 0.1 * pres) * (1 + 0.06 * m);
        this._card.set_scale(cs, cs);
        this._card.opacity = Math.round(255 * clamp(pres, 0, 1) * clamp(1 - m / 0.3, 0, 1));
        const vis = this._card.opacity > 0;
        if (vis !== this._card.visible)
            this._card.visible = vis;
        this._card.reactive = !this._immersiveOn && this._state.available;
    }

    _detach() {
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
        if (this._hideTimer)
            GLib.source_remove(this._hideTimer);
        this._hideTimer = 0;
        if (!this._dialog)
            return;
        const d = this._dialog;
        this._hideSystemPlayer(false);
        for (const [action, id] of this._gestureIds ?? [])
            action.disconnect(id);
        if (this._adjId)
            d._adjustment.disconnect(this._adjId);
        this._stateIds?.forEach(id => this._state.disconnect(id));
        for (const a of [d._clock, d._notificationsBox].filter(Boolean)) {
            a.remove_all_transitions();
            if (d._adjustment.value === 0)
                a.opacity = 255;
        }
        this._ticker?.destroy();
        if (this._cardVisId)
            this._card.disconnect(this._cardVisId);
        this._cardVisId = 0;
        if (this._listId)
            this._list.disconnect(this._listId);
        this._listId = 0;
        if (this._inList) {
            this._card.destroy();
            this._inList = false;
            try {
                d._notificationsBox._updateVisibility?.();
            } catch {}
        }
        this._root?.destroy();
        this._root = null;
        this._dialog = null;
    }

    destroy() {
        this._detach();
    }
}
