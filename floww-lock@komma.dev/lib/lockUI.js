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
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FlowwLockLayout} from './layout.js';
import {LockClock} from './clock.js';
import {LockWallpaper} from './wallpaper.js';
import {MusicWidget} from './musicWidget.js';
import {Glass} from './glass.js';
import {Ease, Dur, reveal, smooth} from './motion.js';

const MUSIC_UUID = 'floww-music@komma.dev';
const RELAYOUT_KEYS = [
    'clock-style', 'clock-position', 'clock-size', 'clock-weight', 'font-family', 'clock-font',
    'widget-position', 'widget-lyrics', 'widget-compact', 'prompt-position',
    'notifications-mode', 'notifications-position', 'glass-tint', 'glass-radius', 'glass-material',
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
        const ok = d && d._stack && d._clock?._time && d._clock?._date && d._clock?._hint &&
            d._promptBox && d._notificationsBox && d._otherUserButton && d._adjustment &&
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

        // GNOME's clock stays in its stack (it drives the transition) but is
        // never seen: we draw our own clock and our own hint, which we can
        // place and animate freely. The hint mirrors GNOME's text, which
        // switches between "click" and "swipe" with the input device.
        dialog._clock._time.hide();
        dialog._clock._date.hide();
        dialog._clock.opacity = 0;

        // Our layer. Children go *below* GNOME's stack so the prompt stays on top.
        this._clock = new LockClock(s);
        mainBox.insert_child_below(this._clock, dialog._stack);
        this._hint = new St.Label({style_class: 'floww-hint'});
        this._hint.set_pivot_point(0.5, 0.5);
        this._hintBinding = dialog._clock._hint.bind_property('text', this._hint, 'text',
            GObject.BindingFlags.SYNC_CREATE);
        mainBox.insert_child_below(this._hint, dialog._stack);

        this._api = musicApi();
        this._glasses = [];
        if (this._api) {
            this._music = new MusicWidget(this._api, getBackdrop, s);
            this._music.set_pivot_point(0.5, 0.5);
            this._music.visible = false;
            this._music.connect('activate', () => this._setImmersive(true));
            // Every frame of the fold moves the panel: lay out again.
            this._music.connect('morph-changed', () => mainBox.queue_relayout());
            mainBox.insert_child_below(this._music, dialog._stack);
            this._glasses.push(this._music);
        }

        this._count = this._makeCountPill(getBackdrop);
        this._count.visible = false;
        mainBox.insert_child_below(this._count, dialog._stack);
        this._glasses.push(this._count);

        // Full-screen lyrics, on top of everything but the prompt. It grows
        // out of the music widget and shrinks back into it (Floww Music
        // drives that motion); the widget dissolves as the view takes over.
        if (this._api) {
            this._immersive = this._api.createImmersive({clock: true});
            mainBox.insert_child_below(this._immersive, dialog._stack);
            this._immersive.connect('close-request', () => this._setImmersive(false));
            this._immersive.connect('progress', (v, p) => this._onImmersiveProgress(p));
        }

        // Swap in our layout manager (restored on detach).
        this._oldLayout = mainBox.layout_manager;
        this._layout = new FlowwLockLayout({
            stack: dialog._stack,
            hint: this._hint,
            adjustment: dialog._adjustment,
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
        this._syncMusic(false);
        this._syncNotifications(false);
        this._music?.setCompact(this._wantCompact(), false);
        this._onPromptProgress();
        this._intro();
    }

    // Everything drifts in together when the lock screen comes up: the clock
    // settles down from above, the rest rises into place, slightly staggered.
    _intro() {
        const parts = [
            [this._clock, -14, 0],
            [this._count, 12, 90],
            [this._music, 18, 150],
            [this._hint, 10, 240],
        ];
        for (const [actor, dy, delay] of parts) {
            if (!actor?.visible)
                continue;
            actor.set_pivot_point(0.5, 0.5);
            actor.opacity = 0;
            actor.translation_y = dy;
            actor.set_scale(0.97, 0.97);
            actor.ease({opacity: 255, translation_y: 0, scale_x: 1, scale_y: 1,
                duration: Dur.slow + 180, delay, mode: Ease.enter});
        }
    }

    // ── Notifications ───────────────────────────────────────────────────
    _makeCountPill(getBackdrop) {
        const pill = new Glass(getBackdrop, this._settings, {
            styleClass: 'floww-glass floww-count', radius: 22, reactive: true,
            getFill: this._api ? () => this._api.createAmbient({styleClass: 'flow-ambient floww-ambient-fill', dim: 0.85}) : null,
        });
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

    // GNOME shows its own media card for the player in the notification
    // list; with our music widget on screen that's a duplicate.
    _hideSystemPlayer(hide, dialog = this._dialog) {
        try {
            const players = dialog?._notificationsBox?._players;
            const bus = this._api?.state.track?.busName;
            for (const [player, message] of players ?? []) {
                const ours = !!bus && player?._busName === bus;
                message.visible = !(hide && ours);
            }
        } catch (e) {
            console.debug(`Floww Lock: could not hide system player: ${e.message}`);
        }
    }

    _syncNotifications(animate = true) {
        if (!this._dialog)
            return;
        this._hideSystemPlayer(!!this._musicShown);
        const mode = this._effectiveNotifMode();
        const n = this._notificationCount();
        const box = this._dialog._notificationsBox;
        const boxOpacity = mode === 'full' && !this._immersiveOn ? 255 : 0;
        if (this._boxOpacity !== boxOpacity) {
            this._boxOpacity = boxOpacity;
            if (animate)
                box.ease({opacity: boxOpacity, duration: Dur.base, mode: boxOpacity ? Ease.enter : Ease.exit});
            else
                box.opacity = boxOpacity;
        }
        box.reactive = mode === 'full';
        this._setCountText(n === 1 ? '1 notification' : `${n} notifications`, animate);
        const showCount = mode === 'count' && n > 0 && !this._peeking && !this._immersiveOn;
        if (animate)
            reveal(this._count, showCount, {dy: -6});
        else
            this._count.visible = showCount;
        // Glass look for GNOME's notification cards.
        for (const child of this._notifBox ?? [])
            child.add_style_class_name('floww-notification');
        this._layout.notifMode = mode;
        this._mainBox.queue_relayout();
    }

    _setCountText(text, animate) {
        const l = this._countLabel;
        if (l.text === text)
            return;
        if (!animate || !l.mapped) {
            l.text = text;
            return;
        }
        l.remove_all_transitions();
        l.ease({opacity: 0, translation_y: -4, duration: Dur.fast, mode: Ease.exit,
            onStopped: () => {
                l.text = text;
                l.translation_y = 4;
                l.ease({opacity: 255, translation_y: 0, duration: Dur.base, mode: Ease.enter});
            }});
    }

    // ── Music ───────────────────────────────────────────────────────────
    _syncMusic(animate = true) {
        if (!this._music)
            return;
        const show = this._api.state.available &&
            this._settings.get_string('widget-position') !== 'hidden';
        if (!show)
            this._setImmersive(false);
        this._musicShown = show;
        if (animate)
            reveal(this._music, show, {dy: 12, scale: 0.96});
        else
            this._music.visible = show;
        this._syncNotifications(animate);
    }

    _wantCompact() {
        return this._settings.get_boolean('widget-compact') && this._dialog._adjustment.value > 0;
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
        if (on)
            im.present(this._music);
        else if (this._dialog._adjustment.value > 0)
            im.hideNow(); // the prompt is coming: get out of its way at once
        else
            im.dismiss(this._musicShown ? this._music : null);
        // The rest of the screen recedes behind the lyrics, and comes back.
        // (The music widget follows the view's progress instead.)
        const others = [this._clock, this._count, this._hint].filter(a => a?.visible);
        for (const a of others) {
            a.set_pivot_point(0.5, 0.5);
            const s = on ? 0.96 : 1;
            a.ease({opacity: on ? 0 : 255, scale_x: s, scale_y: s,
                duration: on ? Dur.base : Dur.slow, mode: on ? Ease.exit : Ease.enter});
        }
        this._syncNotifications();
    }

    // The widget hands over to the immersive view in the first third of the
    // expansion (and comes back in the last third of the collapse).
    _onImmersiveProgress(p) {
        const m = this._music;
        if (!m?.visible)
            return;
        m.remove_transition('opacity');
        const k = Math.min(1, Math.max(0, p / 0.3));
        m.opacity = Math.round(255 * (1 - k));
        m.set_pivot_point(0.5, 0.5);
        m.set_scale(1 + 0.04 * k, 1 + 0.04 * k);
    }

    // ── Prompt transition ───────────────────────────────────────────────
    _onPromptProgress() {
        const d = this._dialog;
        const p = Math.min(1, Math.max(0, d._adjustment.value));
        if (p > 0 && this._immersiveOn)
            this._setImmersive(false);

        // GNOME zooms the prompt in from 30% and 200px below; with the prompt
        // anchored to the player that reads as a jump. Ours: it rises with the
        // layout (see layout.js), fading and settling from 94%.
        // (This handler runs after GNOME's, so these values win.)
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const k = smooth(p);
        d._promptBox.set({
            opacity: Math.round(255 * k),
            scale_x: 0.94 + 0.06 * k,
            scale_y: 0.94 + 0.06 * k,
            translation_y: 0,
        });
        d._clock.opacity = 0;
        d._clock.translation_y = 0;
        this._hint.opacity = Math.round(255 * (1 - smooth(p * 1.6)));
        this._hint.translation_y = Math.round(8 * p * scaleFactor);

        // The music widget folds into the one-line player (or, with that
        // off, steps aside when it would be in the prompt's way).
        if (this._music) {
            if (this._settings.get_boolean('widget-compact')) {
                this._music.setCompact(p > 0);
            } else {
                const centered = this._settings.get_string('prompt-position') === 'center';
                const inTheWay = centered || this._settings.get_string('widget-position') === 'bottom-center';
                if (this._musicShown && !this._immersiveOn && inTheWay) {
                    this._music.remove_transition('opacity');
                    this._music.opacity = Math.round(255 * (1 - k));
                }
            }
        }
        this._mainBox.queue_relayout();
        for (const g of this._glasses)
            g.refreshBackdrop();
    }

    // ── Styling ─────────────────────────────────────────────────────────
    _applyFont() {
        const font = this._settings.get_string('font-family');
        this._mainBox.set_style(`font-family: ${font};`);
        // The expanded view (its clock above all) speaks the lock's font too.
        this._immersive?.set_style(`font-family: ${font};`);
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
            // Let GNOME put its own transforms back.
            d._setTransitionProgress?.(d._adjustment.value);
            d.remove_style_class_name('floww-lock');
        } catch (e) {
            console.debug(`Floww Lock: restore skipped: ${e.message}`);
        }
        this._hintBinding?.unbind();
        this._hintBinding = null;
        for (const a of [this._clock, this._hint, this._music, this._count, this._immersive])
            a?.destroy();
        this._wallpaper?.destroy();
        this._wallpaper = null;
        this._glasses = [];
    }

    destroy() {
        this._detach();
    }
}
