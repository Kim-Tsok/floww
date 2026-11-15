// Fullscreen lyrics on the desktop, opened from the top bar player.
//
// The immersive view grows out of the popover card, covers the primary
// monitor above everything (top chrome), takes the keyboard (Esc / F11 /
// Q close it), hides the pointer while idle and, with "keep the screen on"
// set, holds an idle inhibitor so the lyrics keep playing while you're
// away from the laptop. Locking the screen or losing the player closes it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ImmersiveView} from './immersive.js';

const CLOSE_KEYS = [Clutter.KEY_Escape, Clutter.KEY_F11, Clutter.KEY_q, Clutter.KEY_Q];

export class FullscreenLyrics {
    constructor(state, settings) {
        this._state = state;
        this._settings = settings;
        this._view = null;
        this._grab = null;
        this._returnTo = null;
        this._stateId = state.connect('availability', () => {
            if (!state.available)
                this.close();
        });
        this._sessionId = Main.sessionMode.connect('updated', () => {
            if (Main.sessionMode.isLocked)
                this._teardown();
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._fit());
    }

    get isOpen() {
        return !!this._view?.isOpen;
    }

    // `from`: the actor it grows out of; `returnTo`: where it shrinks back.
    open(from, returnTo = from) {
        if (!this._state.available || Main.sessionMode.isLocked)
            return;
        this._returnTo = returnTo;
        if (!this._view)
            this._build();
        this._fit();
        this._view.present(from);
        if (!this._grab)
            this._grab = Main.pushModal(this._view, {actionMode: Shell.ActionMode.NONE});
    }

    close() {
        if (!this._view?.isOpen)
            return;
        // Hand the keyboard back right away; the view shrinks on its own.
        this._popModal();
        const target = this._returnTo?.mapped ? this._returnTo : null;
        this._view.dismiss(target);
    }

    _build() {
        const view = new ImmersiveView(this._state, this._settings, {
            clock: true,
            exitButton: true,
            hideCursor: true,
            hint: 'Esc to exit · click the background to go back',
        });
        view.add_style_class_name('flow-fullscreen');
        view.connect('close-request', () => this.close());
        // 'closed' fires from the view's own frame callback: tear down
        // after it returns.
        view.connect('closed', () => {
            if (this._closedId)
                return;
            this._closedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._closedId = 0;
                if (this._view === view && !view.isOpen)
                    this._teardown();
                return GLib.SOURCE_REMOVE;
            });
        });
        view.connect('key-press-event', (a, event) => {
            if (CLOSE_KEYS.includes(event.get_key_symbol())) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            if (event.get_key_symbol() === Clutter.KEY_space) {
                this._state.playPause();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        Main.layoutManager.addTopChrome(view);
        this._view = view;
    }

    _fit() {
        const m = Main.layoutManager.primaryMonitor;
        if (!this._view || !m)
            return;
        this._view.set_position(m.x, m.y);
        this._view.set_size(m.width, m.height);
    }

    _popModal() {
        if (!this._grab)
            return;
        try {
            Main.popModal(this._grab);
        } catch (e) {
            console.debug(`Floww Music: popModal: ${e.message}`);
        }
        this._grab = null;
    }

    _teardown() {
        this._popModal();
        const view = this._view;
        this._view = null;
        if (view) {
            Main.layoutManager.removeChrome(view);
            view.destroy();
        }
    }

    destroy() {
        if (this._closedId)
            GLib.source_remove(this._closedId);
        this._closedId = 0;
        this._state.disconnect(this._stateId);
        Main.sessionMode.disconnect(this._sessionId);
        Main.layoutManager.disconnect(this._monitorsId);
        this._teardown();
    }
}
