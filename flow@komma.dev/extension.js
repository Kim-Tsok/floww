// Flow — Apple Music–style Spotify lyrics for GNOME Shell.
//
// One PlayerState feeds three surfaces. In the user session we show the
// desktop widget and the top bar pill; when the screen locks those are torn
// down and the lock screen UI takes over (and vice versa on unlock).

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PlayerState} from './lib/playerState.js';
import {destroySession} from './lib/http.js';
import {addIndicator} from './lib/ui/panelPill.js';
import {DesktopWidget} from './lib/ui/desktopWidget.js';
import {LockScreenUI} from './lib/ui/lockScreen.js';

export default class FlowExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._state = new PlayerState(this._settings);
        this._mode = null;

        this._sessionId = Main.sessionMode.connect('updated', () => this._syncMode());
        this._settingIds = [
            'widget-enabled', 'panel-enabled', 'panel-position', 'lock-enabled',
        ].map(k => this._settings.connect(`changed::${k}`, () => this._rebuild()));

        this._syncMode();
    }

    disable() {
        Main.sessionMode.disconnect(this._sessionId);
        this._settingIds.forEach(id => this._settings.disconnect(id));
        this._teardown();
        this._state.destroy();
        destroySession();
        this._state = null;
        this._settings = null;
    }

    _syncMode() {
        const mode = Main.sessionMode.isLocked ? 'lock' : 'user';
        if (mode === this._mode)
            return;
        this._mode = mode;
        this._rebuild();
    }

    _rebuild() {
        this._teardown();
        const s = this._settings;
        if (this._mode === 'lock') {
            if (s.get_boolean('lock-enabled'))
                this._lock = new LockScreenUI(this._state, s);
            return;
        }
        if (s.get_boolean('panel-enabled'))
            this._indicator = addIndicator(this.uuid, this._state, s);
        if (s.get_boolean('widget-enabled'))
            this._widget = new DesktopWidget(this._state, s);
    }

    _teardown() {
        this._indicator?.destroy();
        this._indicator = null;
        this._widget?.destroy();
        this._widget = null;
        this._lock?.destroy();
        this._lock = null;
    }
}
