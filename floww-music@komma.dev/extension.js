// Floww Music — Apple Music–style Spotify lyrics for GNOME Shell.
//
// One PlayerState feeds three surfaces. In the user session we show the
// desktop widget and the top bar pill; when the screen locks those are torn
// down and the lock screen UI takes over (and vice versa on unlock).
//
// Floww Lock (floww-lock@komma.dev) builds its own lock screen and borrows
// our player through `extension.api`; while it is enabled we leave the lock
// screen to it.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ExtensionUtils from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PlayerState} from './lib/playerState.js';
import {destroySession} from './lib/http.js';
import {addIndicator} from './lib/ui/panelPill.js';
import {DesktopWidget} from './lib/ui/desktopWidget.js';
import {LockScreenUI} from './lib/ui/lockScreen.js';
import {makeImmersive} from './lib/ui/immersive.js';
import {releaseAll} from './lib/inhibit.js';
import {forgetToken} from './lib/lyrics/spotify.js';
import {PlayerCard} from './lib/ui/playerCard.js';
import {LyricsView} from './lib/ui/lyricsView.js';
import {Controls, ArtView, Scrubber, AmbientBackground, SwapLabel, EqBars} from './lib/ui/widgets.js';

const LOCK_UUID = 'floww-lock@komma.dev';

export default class FlowwMusicExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._state = new PlayerState(this._settings);
        this._mode = null;

        const settings = this._settings;
        const state = this._state;
        // Public surface for Floww Lock. Bump `version` on breaking changes.
        this.api = {
            version: 1,
            state,
            settings,
            createCard: (variant = 'lock') => new PlayerCard(state, settings, variant),
            createLyricsView: opts => new LyricsView(state, settings, opts),
            createControls: opts => new Controls(state, opts),
            createArt: opts => new ArtView(state, opts),
            createScrubber: opts => new Scrubber(state, opts),
            createAmbient: opts => new AmbientBackground(state, opts),
            createSwapLabel: opts => new SwapLabel(opts),
            createEqBars: () => new EqBars(state),
            // Full-screen art + lyrics view (the lock screen "immersive" mode).
            // opts: {clock, exitButton, hideCursor, hint}. The view has
            // present(fromActor) / dismiss(toActor) / hideNow() and emits
            // 'close-request', 'progress' (0…1) and 'closed'.
            createImmersive: (opts = {}) => makeImmersive(state, settings, opts),
        };

        this._sessionId = Main.sessionMode.connect('updated', () => this._syncMode());
        this._settingIds = [
            'widget-enabled', 'panel-enabled', 'panel-position', 'lock-enabled',
        ].map(k => this._settings.connect(`changed::${k}`, () => this._rebuild()));
        this._lockActive = this._isLockExtensionActive();
        this._extId = Main.extensionManager.connect('extension-state-changed', (m, ext) => {
            if (ext?.uuid !== LOCK_UUID)
                return;
            const active = this._isLockExtensionActive();
            if (active !== this._lockActive) {
                this._lockActive = active;
                if (this._mode === 'lock')
                    this._rebuild();
            }
        });

        this._syncMode();
    }

    disable() {
        // This extension uses the 'unlock-dialog' session mode to show the
        // player and its controls on the lock screen (when Floww Lock isn't
        // doing it), so it stays enabled while the screen is locked.
        // disable() therefore runs on a real disable, uninstall or logout,
        // and tears down everything built for either the desktop or the
        // lock screen.
        Main.sessionMode.disconnect(this._sessionId);
        Main.extensionManager.disconnect(this._extId);
        this._settingIds.forEach(id => this._settings.disconnect(id));
        this._teardown();
        releaseAll();
        forgetToken();
        this._state.destroy();
        destroySession();
        this.api = null;
        this._state = null;
        this._settings = null;
    }

    _isLockExtensionActive() {
        const ext = Main.extensionManager.lookup(LOCK_UUID);
        return ext?.state === ExtensionUtils.ExtensionState.ACTIVE;
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
            if (s.get_boolean('lock-enabled') && !this._lockActive)
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
