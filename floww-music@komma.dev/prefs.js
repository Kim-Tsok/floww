import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Secret from 'gi://Secret';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class FlowPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const SECRET_SCHEMA = new Secret.Schema('dev.komma.Flow',
            Secret.SchemaFlags.NONE, {key: Secret.SchemaAttributeType.STRING});
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Floww Music', icon_name: 'audio-x-generic-symbolic'});
        window.add(page);

        // Surfaces
        const surfaces = new Adw.PreferencesGroup({title: 'Surfaces'});
        page.add(surfaces);
        surfaces.add(switchRow(settings, 'widget-enabled', 'Desktop widget', 'Floating card under your windows'));
        surfaces.add(switchRow(settings, 'widget-hide-when-paused', 'Hide widget while paused'));
        const reset = new Adw.ActionRow({title: 'Reset widget position'});
        const resetBtn = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        resetBtn.connect('clicked', () => {
            settings.set_int('widget-x', -1);
            settings.set_int('widget-y', -1);
        });
        reset.add_suffix(resetBtn);
        surfaces.add(reset);
        surfaces.add(switchRow(settings, 'panel-enabled', 'Top bar pill'));
        surfaces.add(switchRow(settings, 'panel-lyrics', 'Live lyric line in the top bar'));

        const positions = ['left', 'center', 'right'];
        const posRow = new Adw.ComboRow({
            title: 'Top bar position',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
            selected: Math.max(0, positions.indexOf(settings.get_string('panel-position'))),
        });
        posRow.connect('notify::selected', () => settings.set_string('panel-position', positions[posRow.selected]));
        surfaces.add(posRow);

        surfaces.add(switchRow(settings, 'lock-enabled', 'Lock screen', 'Card under the clock; click it for immersive lyrics'));
        surfaces.add(switchRow(settings, 'lock-hide-system-player', "Hide GNOME's media card on the lock screen"));

        // Source
        const source = new Adw.PreferencesGroup({title: 'Player'});
        page.add(source);
        const sources = ['any', 'spotify'];
        const sourceRow = new Adw.ComboRow({
            title: 'Follow',
            subtitle: 'Any app that plays audio (browsers, Rhythmbox, mpv…) or only Spotify',
            model: Gtk.StringList.new(['Any media player', 'Spotify only']),
            selected: Math.max(0, sources.indexOf(settings.get_string('player-source'))),
        });
        sourceRow.connect('notify::selected', () => settings.set_string('player-source', sources[sourceRow.selected]));
        source.add(sourceRow);

        // Lyrics
        const lyrics = new Adw.PreferencesGroup({title: 'Lyrics'});
        page.add(lyrics);
        lyrics.add(switchRow(settings, 'blur-lyrics', 'Depth blur', 'Blur lines away from the one being sung'));
        const offset = new Adw.SpinRow({
            title: 'Timing offset',
            subtitle: 'Milliseconds; positive shows lyrics earlier',
            adjustment: new Gtk.Adjustment({lower: -3000, upper: 3000, step_increment: 50, page_increment: 250}),
        });
        settings.bind('lyrics-offset-ms', offset, 'value', Gio.SettingsBindFlags.DEFAULT);
        lyrics.add(offset);

        const hasCava = GLib.find_program_in_path('cava') !== null;
        lyrics.add(switchRow(settings, 'visualizer-cava', 'Live visualizer with cava',
            hasCava
                ? 'When a song has no lyrics, the expanded player shows bars that follow the actual audio'
                : 'cava is not installed, so the visualizer is simulated. Install it with: sudo dnf install cava'));
        lyrics.add(switchRow(settings, 'keep-awake', 'Keep the screen on in full screen',
            'While lyrics are full screen (from the top bar, or expanded on the lock screen) the screen won\'t dim, blank or lock. Lets go after 10 minutes paused.'));

        // Spotify fallback
        const sp = new Adw.PreferencesGroup({
            title: 'Spotify lyrics fallback',
            description: 'Unofficial and may stop working at any time. Used only when LRCLIB has no synced lyrics. ' +
                'The cookie also lets Floww tell when Spotify\'s DJ is playing, to show the DJ button. ' +
                'Your sp_dc cookie is stored in the GNOME keyring and is only ever sent to spotify.com.',
        });
        page.add(sp);
        sp.add(switchRow(settings, 'spotify-fallback', 'Use Spotify as a fallback'));
        const cookie = new Adw.PasswordEntryRow({title: 'sp_dc cookie'});
        Secret.password_lookup(SECRET_SCHEMA, {key: 'sp_dc'}, null, (o, res) => {
            try {
                if (Secret.password_lookup_finish(res))
                    cookie.set_text('••••••••');
            } catch {}
        });
        cookie.set_show_apply_button(true);
        cookie.connect('apply', () => {
            const value = cookie.get_text().trim();
            if (!value || value.startsWith('•'))
                return;
            Secret.password_store(SECRET_SCHEMA, {key: 'sp_dc'}, Secret.COLLECTION_DEFAULT,
                'Flow: Spotify sp_dc cookie', value, null, (o, res) => {
                    try {
                        Secret.password_store_finish(res);
                        cookie.set_text('••••••••');
                    } catch (e) {
                        console.error(e);
                    }
                });
        });
        sp.add(cookie);
        const clear = new Adw.ActionRow({title: 'Forget cookie'});
        const clearBtn = new Gtk.Button({label: 'Forget', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        clearBtn.connect('clicked', () => {
            Secret.password_clear(SECRET_SCHEMA, {key: 'sp_dc'}, null, () => cookie.set_text(''));
        });
        clear.add_suffix(clearBtn);
        sp.add(clear);
    }
}
