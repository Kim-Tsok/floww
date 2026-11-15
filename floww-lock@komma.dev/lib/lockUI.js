// Floww Lock: restyles GNOME's unlock dialog.
//
// Safety rules (same as Floww Music's lock card):
//  • GNOME keeps the password prompt, authentication, key handling and the
//    clock ⇄ prompt transition. We only re-lay-out, restyle and add widgets.
//  • We never take key focus, so typing always reaches the password field.
//  • If the dialog's internals don't look as expected, we don't attach at
//    all; a stock lock screen beats a broken one.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FlowwLockLayout} from './layout.js';
import {LockClock} from './clock.js';
import {LockWallpaper} from './wallpaper.js';
import {MusicWidget} from './musicWidget.js';
import {Glass} from './glass.js';

const MUSIC_UUID = 'floww-music@komma.dev';
const RELAYOUT_KEYS = [
    'clock-style', 'clock-position', 'clock-size', 'clock-weight', 'font-family',
    'widget-position', 'widget-lyrics', 'prompt-position',
    'notifications-mode', 'notifications-position', 'glass-tint', 'glass-radius',
];

function musicApi() {
    const ext = Main.extensionManager.lookup(MUSIC_UUID);
    const api = ext?.stateObj?.api;
    return api?.version === 1 ? api : null;
}

function pointerInside(actor) {
    if (!actor?.visible || !actor.mapped)
        return false;
    const [x, y] = global.get_pointer();
    let a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
    while (a) {
        if (a === actor)
            return true;
        a = a.get_parent();
    }
    return false;
}

export class LockUI {
    constructor(settings) {
        this._settings = settings;
        this._tries = 0;
        this._tryAttach();
    }

    _tryAttach() {
        const d = Main.screenShield?._dialog;
        const ok = d && d._stack && d._clock?._time && d._clock?._date &&
            d._notificationsBox && d._otherUserButton && d._adjustment &&
            d._backgroundGroup && d._stack.get_parent()?.layout_manager;
        if (ok) {
            try {
                this._attach(d);
            } catch (e) {
                logError(e, 'Floww Lock: attach failed, falling back to the stock lock screen');
                this._detach();
            }
            return;
        }
        if (this._tries++ > 30)
            return;
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._retryId = 0;
            this._tryAttach();
            return GLib.SOURCE_REMOVE;
        });
    }

    _attach(dialog) {
        this._dialog = dialog;
        const s = this._settings;
        const mainBox = dialog._stack.get_parent();
        this._mainBox = mainBox;
        dialog.add_style_class_name('floww-lock');

        this._wallpaper = new LockWallpaper(dialog, s, () => this._refreshGlass());
        const getBackdrop = () => this._wallpaper?.backdrop ?? null;

        // GNOME's clock: keep only the "click or press a key" hint.
        dialog._clock._time.hide();
        dialog._clock._date.hide();

        // Our layer. Children go *below* GNOME's stack so the prompt stays on top.
        this._clock = new LockClock(s);
        mainBox.insert_child_below(this._clock, dialog._stack);

        this._api = musicApi();
        this._glasses = [];
        if (this._api) {
            this._music = new MusicWidget(this._api, getBackdrop, s);
            this._music.set_pivot_point(0.5, 0.5);
            this._music.connect('activate', () => this._setImmersive(true));
            mainBox.insert_child_below(this._music, dialog._stack);
            this._glasses.push(this._music);
        }

        this._count = this._makeCountPill(getBackdrop);
        mainBox.insert_child_below(this._count, dialog._stack);
        this._glasses.push(this._count);

        // Full-screen lyrics, on top of everything but the prompt.
        if (this._api) {
            this._immersive = this._api.createImmersive();
            this._immersive.visible = false;
            this._immersive.opacity = 0;
            this._immersive.set_pivot_point(0.5, 0.5);
            mainBox.insert_child_below(this._immersive, dialog._stack);
            const back = new Clutter.ClickGesture();
            back.connect('may-recognize', () => !this._pointerOnControl(this._immersive));
            back.connect('recognize', () => this._setImmersive(false));
            this._immersive.add_action(back);
        }

        // Swap in our layout manager (restored on detach).
        this._oldLayout = mainBox.layout_manager;
        this._layout = new FlowwLockLayout({
            stack: dialog._stack,
            notifications: dialog._notificationsBox,
            userButton: dialog._otherUserButton,
            clock: this._clock,
            music: this._music ?? null,
            count: this._count,
            immersive: this._immersive ?? null,
        }, s);
        mainBox.layout_manager = this._layout;

        // Our clicks must not also summon the password prompt.
        this._gestureIds = [];
        for (const action of dialog.get_actions()) {
            if (action instanceof Clutter.ClickGesture) {
                const id = action.connect('may-recognize', () => !this._pointerOnOurs());
                this._gestureIds.push([action, id]);
            }
        }

        this._adjId = dialog._adjustment.connect('notify::value', () => this._onPromptProgress());
        this._settingIds = RELAYOUT_KEYS.map(k => s.connect(`changed::${k}`, () => this._relayout()));
        this._settingIds.push(s.connect('changed::notifications-mode', () => this._syncNotifications()));
        if (this._api) {
            this._stateIds = [
                this._api.state.connect('availability', () => this._syncMusic()),
            ];
        }
        this._notifBox = dialog._notificationsBox._notificationBox;
        this._notifChildId = this._notifBox?.connect('child-added', () => this._syncNotifications());
        this._notifRemovedId = this._notifBox?.connect('child-removed', () => this._syncNotifications());

        this._applyFont();
        this._syncMusic();
        this._syncNotifications();
        this._onPromptProgress();
    }

    // ── Notifications ───────────────────────────────────────────────────
    _makeCountPill(getBackdrop) {
        const pill = new Glass(getBackdrop, this._settings, {styleClass: 'floww-glass floww-count', radius: 22, reactive: true});
        const row = new St.BoxLayout({style_class: 'floww-count-row', x_align: Clutter.ActorAlign.CENTER});
        row.add_child(new St.Icon({icon_name: 'preferences-system-notifications-symbolic', icon_size: 16,
            style_class: 'floww-count-icon'}));
        this._countLabel = new St.Label({style_class: 'floww-count-label', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._countLabel);
        pill.setChild(row);
        // Click the pill to peek at the full list; it folds back on its own
        // after a while.
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => this._peekNotifications());
        pill.add_action(click);
        return pill;
    }

    _notificationCount() {
        let n = 0;
        for (const child of this._notifBox ?? []) {
            if (child.visible)
                n++;
        }
        return n;
    }

    _peekNotifications() {
        this._peeking = true;
        this._syncNotifications();
        if (this._peekId)
            GLib.source_remove(this._peekId);
        this._peekId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
            this._peekId = 0;
            this._peeking = false;
            this._syncNotifications();
            return GLib.SOURCE_REMOVE;
        });
    }

    _effectiveNotifMode() {
        const mode = this._settings.get_string('notifications-mode');
        return mode === 'count' && this._peeking ? 'full' : mode;
    }

    // GNOME shows its own media card for Spotify in the notification list;
    // with our music widget on screen that's a duplicate.
    _hideSystemPlayer(hide, dialog = this._dialog) {
        try {
            const players = dialog?._notificationsBox?._players;
            for (const [player, message] of players ?? []) {
                if (String(player?._busName ?? '').includes('spotify'))
                    message.visible = !hide;
            }
        } catch (e) {
            console.debug(`Floww Lock: could not hide system player: ${e.message}`);
        }
    }

    _syncNotifications() {
        if (!this._dialog)
            return;
        this._hideSystemPlayer(!!this._music?.visible);
        const mode = this._effectiveNotifMode();
        const n = this._notificationCount();
        const box = this._dialog._notificationsBox;
        box.opacity = mode === 'full' && !this._immersiveOn ? 255 : 0;
        box.reactive = mode === 'full';
        this._countLabel.text = n === 1 ? '1 notification' : `${n} notifications`;
        this._count.visible = mode === 'count' && n > 0 && !this._peeking;
        // Glass look for GNOME's notification cards.
        for (const child of this._notifBox ?? [])
            child.add_style_class_name('floww-notification');
        this._layout.notifMode = mode;
        this._mainBox.queue_relayout();
    }

    // ── Music ───────────────────────────────────────────────────────────
    _syncMusic() {
        if (!this._music)
            return;
        const show = this._api.state.available &&
            this._settings.get_string('widget-position') !== 'hidden';
        if (!show)
            this._setImmersive(false);
        this._music.visible = show;
        this._syncNotifications();
    }

    _pointerOnControl(container) {
        const [x, y] = global.get_pointer();
        let a = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (a && a !== container) {
            if (a instanceof St.Button || a.has_style_class_name?.('flow-scrubber-hit'))
                return true;
            a = a.get_parent();
        }
        return false;
    }

    _pointerOnOurs() {
        return pointerInside(this._music) || pointerInside(this._count) ||
            (this._immersiveOn && pointerInside(this._immersive));
    }

    _setImmersive(on) {
        if (!this._immersive)
            return;
        if (on && (!this._api.state.available || this._dialog._adjustment.value > 0))
            on = false;
        if (on === !!this._immersiveOn)
            return;
        this._immersiveOn = on;
        const im = this._immersive;
        const others = [this._clock, this._music, this._count, this._dialog._clock].filter(Boolean);
        im.remove_all_transitions();
        if (on) {
            im.show();
            im.reactive = true;
            im.set_scale(0.94, 0.94);
            im.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 420,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        } else {
            im.reactive = false;
            im.ease({opacity: 0, scale_x: 0.96, scale_y: 0.96, duration: 280,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (!this._immersiveOn)
                        im.hide();
                }});
        }
        for (const a of others) {
            a.ease({opacity: on ? 0 : 255, duration: on ? 220 : 380,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._syncNotifications();
    }

    // ── Prompt transition ───────────────────────────────────────────────
    _onPromptProgress() {
        const p = this._dialog._adjustment.value;
        if (p > 0 && this._immersiveOn)
            this._setImmersive(false);
        // With the prompt in the middle, step widgets aside while typing.
        // At the bottom (macOS style) everything stays put.
        const centered = this._settings.get_string('prompt-position') === 'center';
        const fade = centered ? 1 - Math.min(1, p) : 1;
        for (const a of [this._music, this._count].filter(Boolean)) {
            if (!this._immersiveOn)
                a.opacity = Math.round(255 * fade);
        }
    }

    // ── Styling ─────────────────────────────────────────────────────────
    _applyFont() {
        const font = this._settings.get_string('font-family');
        this._mainBox.set_style(`font-family: ${font};`);
    }

    _relayout() {
        this._applyFont();
        this._syncMusic();
        this._syncNotifications();
        this._refreshGlass();
        this._onPromptProgress();
    }

    _refreshGlass() {
        this._mainBox?.queue_relayout();
        for (const g of this._glasses ?? [])
            g.refreshBackdrop();
    }

    // ── Teardown ────────────────────────────────────────────────────────
    _detach() {
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
        if (this._peekId)
            GLib.source_remove(this._peekId);
        this._peekId = 0;
        const d = this._dialog;
        if (!d)
            return;
        this._dialog = null;

        this._settingIds?.forEach(id => this._settings.disconnect(id));
        this._stateIds?.forEach(id => this._api.state.disconnect(id));
        for (const [action, id] of this._gestureIds ?? [])
            action.disconnect(id);
        // The dialog may already be on its way out (unlock): be defensive.
        try {
            if (this._adjId)
                d._adjustment.disconnect(this._adjId);
            if (this._notifChildId)
                this._notifBox.disconnect(this._notifChildId);
            if (this._notifRemovedId)
                this._notifBox.disconnect(this._notifRemovedId);
            for (const child of this._notifBox ?? [])
                child.remove_style_class_name('floww-notification');
            this._hideSystemPlayer(false, d);
            if (this._mainBox && this._oldLayout)
                this._mainBox.layout_manager = this._oldLayout;
            this._mainBox?.set_style(null);
            d._notificationsBox.opacity = 255;
            d._notificationsBox.reactive = true;
            d._clock._time.show();
            d._clock._date.show();
            d._clock.opacity = d._adjustment.value > 0 ? 0 : 255;
            d.remove_style_class_name('floww-lock');
        } catch (e) {
            console.debug(`Floww Lock: restore skipped: ${e.message}`);
        }
        for (const a of [this._clock, this._music, this._count, this._immersive])
            a?.destroy();
        this._wallpaper?.destroy();
        this._wallpaper = null;
        this._glasses = [];
    }

    destroy() {
        this._detach();
    }
}
