// Floww Lock — a customizable, macOS-style liquid-glass lock screen.
//
// Active only while the screen is locked. The music widget comes from
// Floww Music (floww-music@komma.dev) when it is enabled; Floww Music steps
// aside on the lock screen while this extension is on.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LockUI} from './lib/lockUI.js';

export default class FlowwLockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sessionId = Main.sessionMode.connect('updated', () => this._sync());
        // Floww Music may be enabled after us; rebuild so the widget appears.
        this._extId = Main.extensionManager.connect('extension-state-changed', (m, ext) => {
            if (ext?.uuid === 'floww-music@komma.dev' && this._ui)
                this._rebuild();
        });
        this._sync();
    }

    disable() {
        // This extension uses the 'unlock-dialog' session mode because it
        // only changes the lock screen, so it must stay enabled while the
        // screen is locked. disable() therefore runs on a real disable,
        // uninstall or logout, and puts GNOME's unlock dialog back exactly
        // as it was.
        Main.sessionMode.disconnect(this._sessionId);
        Main.extensionManager.disconnect(this._extId);
        this._ui?.destroy();
        this._ui = null;
        this._settings = null;
    }

    _sync() {
        const locked = Main.sessionMode.isLocked;
        if (locked && !this._ui)
            this._ui = new LockUI(this._settings);
        else if (!locked && this._ui)
            this._teardown();
    }

    _rebuild() {
        this._teardown();
        this._sync();
    }

    _teardown() {
        this._ui?.destroy();
        this._ui = null;
    }
}
