import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function choiceRow(settings, key, title, options, subtitle = '') {
    const values = options.map(o => o[0]);
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(options.map(o => o[1])),
        selected: Math.max(0, values.indexOf(settings.get_string(key))),
    });
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    settings.connect(`changed::${key}`, () => {
        const i = Math.max(0, values.indexOf(settings.get_string(key)));
        if (row.selected !== i)
            row.selected = i;
    });
    return row;
}

function spinRow(settings, key, title, lower, upper, step, subtitle = '') {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function sliderRow(settings, key, title, lower, upper, subtitle = '') {
    const row = new Adw.ActionRow({title, subtitle});
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 10}),
        draw_value: true,
        value_pos: Gtk.PositionType.RIGHT,
        digits: 0,
        hexpand: true,
        width_request: 220,
        valign: Gtk.Align.CENTER,
    });
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(scale);
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

const WEIGHTS = [[200, 'Thin'], [300, 'Light'], [400, 'Regular'], [500, 'Medium'],
    [600, 'Semibold'], [700, 'Bold'], [800, 'Heavy']];

export default class FlowwLockPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(640, 760);

        // ── Look ────────────────────────────────────────────────────────
        const look = new Adw.PreferencesPage({title: 'Look', icon_name: 'preferences-desktop-wallpaper-symbolic'});
        window.add(look);

        const preview = new Adw.PreferencesGroup({
            description: 'Changes apply the next time the screen locks. ' +
                'The music widget needs Floww Music to be enabled.',
        });
        const lockRow = new Adw.ActionRow({title: 'Preview', subtitle: 'Lock the screen now to see your changes'});
        const lockBtn = new Gtk.Button({label: 'Lock now', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        lockBtn.connect('clicked', () => {
            try {
                Gio.Subprocess.new(['loginctl', 'lock-session'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.error(e);
            }
        });
        lockRow.add_suffix(lockBtn);
        preview.add(lockRow);
        look.add(preview);

        // Wallpaper
        const wp = new Adw.PreferencesGroup({title: 'Wallpaper'});
        look.add(wp);
        wp.add(choiceRow(s, 'wallpaper-source', 'Source', [
            ['desktop', 'Same as the desktop'],
            ['custom', 'A different image'],
        ]));
        const fileRow = new Adw.ActionRow({title: 'Lock screen image'});
        const updateFileRow = () => {
            const p = s.get_string('wallpaper-path');
            fileRow.subtitle = p ? GLib.path_get_basename(p) : 'None chosen';
            fileRow.sensitive = s.get_string('wallpaper-source') === 'custom';
        };
        const pick = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        pick.connect('clicked', () => {
            const filter = new Gtk.FileFilter({name: 'Images'});
            filter.add_mime_type('image/*');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
            filters.append(filter);
            const dialog = new Gtk.FileDialog({title: 'Choose a lock screen image', filters, default_filter: filter});
            dialog.open(window, null, (d, res) => {
                try {
                    const file = d.open_finish(res);
                    if (file) {
                        s.set_string('wallpaper-path', file.get_path());
                        s.set_string('wallpaper-source', 'custom');
                    }
                } catch {
                    // cancelled
                }
            });
        });
        fileRow.add_suffix(pick);
        wp.add(fileRow);
        s.connect('changed::wallpaper-path', updateFileRow);
        s.connect('changed::wallpaper-source', updateFileRow);
        updateFileRow();
        wp.add(sliderRow(s, 'wallpaper-blur', 'Blur', 0, 100));
        wp.add(sliderRow(s, 'wallpaper-dim', 'Darken', 0, 80));

        // Glass
        const glass = new Adw.PreferencesGroup({title: 'Liquid glass'});
        look.add(glass);
        const tintRow = new Adw.ActionRow({title: 'Tint', subtitle: 'Colour and strength (alpha) of the glass'});
        const tintBtn = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: true, title: 'Glass tint'}),
            valign: Gtk.Align.CENTER,
        });
        const rgba = new Gdk.RGBA();
        rgba.parse(s.get_string('glass-tint'));
        tintBtn.rgba = rgba;
        tintBtn.connect('notify::rgba', () => {
            const c = tintBtn.rgba;
            s.set_string('glass-tint',
                `rgba(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)},${c.alpha.toFixed(2)})`);
        });
        tintRow.add_suffix(tintBtn);
        glass.add(tintRow);
        glass.add(sliderRow(s, 'glass-blur', 'Frost', 0, 80, 'How much the glass blurs what is behind it'));
        glass.add(sliderRow(s, 'glass-refraction', 'Refraction', 0, 100, 'How strongly the edges bend the wallpaper'));
        glass.add(spinRow(s, 'glass-radius', 'Corner radius', 8, 48, 1));

        // ── Clock ───────────────────────────────────────────────────────
        const clockPage = new Adw.PreferencesPage({title: 'Clock', icon_name: 'preferences-system-time-symbolic'});
        window.add(clockPage);
        const clock = new Adw.PreferencesGroup({title: 'Clock'});
        clockPage.add(clock);
        clock.add(choiceRow(s, 'clock-style', 'Style', [
            ['stacked', 'Date above time (macOS)'],
            ['classic', 'Time above date'],
            ['split', 'Hours above minutes'],
            ['minimal', 'Time only'],
        ]));
        clock.add(choiceRow(s, 'clock-position', 'Position', [
            ['top', 'Top'],
            ['center', 'Center'],
            ['top-left', 'Top left'],
            ['top-right', 'Top right'],
            ['bottom-left', 'Bottom left'],
            ['bottom-right', 'Bottom right'],
        ]));
        clock.add(choiceRow(s, 'clock-format', 'Format', [
            ['system', 'Follow system'],
            ['12h', '12-hour'],
            ['24h', '24-hour'],
        ]));
        clock.add(spinRow(s, 'clock-size', 'Size', 48, 260, 4));
        const weightRow = new Adw.ComboRow({
            title: 'Weight',
            model: Gtk.StringList.new(WEIGHTS.map(w => w[1])),
        });
        const syncWeight = () => {
            const v = s.get_int('clock-weight');
            let best = 0;
            WEIGHTS.forEach((w, i) => {
                if (Math.abs(w[0] - v) < Math.abs(WEIGHTS[best][0] - v))
                    best = i;
            });
            weightRow.selected = best;
        };
        syncWeight();
        weightRow.connect('notify::selected', () => s.set_int('clock-weight', WEIGHTS[weightRow.selected][0]));
        clock.add(weightRow);
        clock.add(sliderRow(s, 'clock-opacity', 'Opacity', 30, 100));

        const fontGroup = new Adw.PreferencesGroup({title: 'Font', description: 'Used by the clock and the widgets'});
        clockPage.add(fontGroup);
        const fontRow = new Adw.ActionRow({title: 'Font family'});
        const fontBtn = new Gtk.FontDialogButton({
            dialog: new Gtk.FontDialog({title: 'Lock screen font'}),
            level: Gtk.FontLevel.FAMILY,
            valign: Gtk.Align.CENTER,
        });
        const first = s.get_string('font-family').split(',')[0].trim();
        fontBtn.font_desc = Pango.FontDescription.from_string(first);
        fontBtn.connect('notify::font-desc', () => {
            const fam = fontBtn.font_desc?.get_family();
            if (fam)
                s.set_string('font-family', `"${fam}", Inter, Cantarell, sans-serif`);
        });
        fontRow.add_suffix(fontBtn);
        const resetFont = new Gtk.Button({icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Back to the default font', css_classes: ['flat']});
        resetFont.connect('clicked', () => s.reset('font-family'));
        fontRow.add_suffix(resetFont);
        fontGroup.add(fontRow);

        // ── Layout ──────────────────────────────────────────────────────
        const layoutPage = new Adw.PreferencesPage({title: 'Layout', icon_name: 'view-grid-symbolic'});
        window.add(layoutPage);
        const widgets = new Adw.PreferencesGroup({title: 'Widgets'});
        layoutPage.add(widgets);
        widgets.add(choiceRow(s, 'widget-position', 'Music widget', [
            ['below-clock', 'Below the clock'],
            ['left', 'Left side'],
            ['right', 'Right side'],
            ['bottom-left', 'Bottom left'],
            ['bottom-right', 'Bottom right'],
            ['hidden', 'Hidden'],
        ]));
        widgets.add(switchRow(s, 'widget-lyrics', 'Live lyrics in the widget'));
        widgets.add(choiceRow(s, 'prompt-position', 'Password prompt', [
            ['bottom', 'Bottom (macOS)'],
            ['center', 'Center (GNOME)'],
        ]));

        const notif = new Adw.PreferencesGroup({title: 'Notifications'});
        layoutPage.add(notif);
        notif.add(choiceRow(s, 'notifications-mode', 'Show', [
            ['full', 'Full notifications'],
            ['count', 'Only a count (click to peek)'],
            ['hidden', 'Nothing'],
        ]));
        notif.add(choiceRow(s, 'notifications-position', 'Position', [
            ['below-widget', 'Below the widgets'],
            ['bottom', 'Bottom'],
            ['right', 'Right side'],
            ['left', 'Left side'],
        ]));

        const reset = new Adw.PreferencesGroup();
        layoutPage.add(reset);
        const resetRow = new Adw.ActionRow({title: 'Reset everything', subtitle: 'Back to the default Floww Lock look'});
        const resetBtn = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        resetBtn.connect('clicked', () => {
            for (const key of s.settings_schema.list_keys())
                s.reset(key);
            rgba.parse(s.get_string('glass-tint'));
            tintBtn.rgba = rgba;
            syncWeight();
        });
        resetRow.add_suffix(resetBtn);
        reset.add(resetRow);
    }
}
