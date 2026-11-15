// Lock screen wallpaper.
//   desktop: GNOME's own lock backgrounds (whatever the desktop uses,
//            slideshows included), with our blur and dim instead of GNOME's.
//   custom:  a separate image, drawn by us on every monitor.
// `backdrop` is the primary monitor's wallpaper actor, which glass clones.

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const KEYS = ['wallpaper-source', 'wallpaper-path', 'wallpaper-blur', 'wallpaper-dim'];

function cssUri(path) {
    return GLib.filename_to_uri(path, null).replace(/"/g, '\\"');
}

export class LockWallpaper {
    constructor(dialog, settings, onChanged) {
        this._dialog = dialog;
        this._settings = settings;
        this._onChanged = onChanged;
        this._custom = [];

        this._group = dialog._backgroundGroup;
        this._ids = KEYS.map(k => settings.connect(`changed::${k}`, () => this.sync()));
        // GNOME rebuilds its backgrounds (monitors, scale) and resets the blur.
        this._groupId = this._group.connect('child-added', () => this._queueSync());
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._queueSync());
        this.sync();
    }

    get backdrop() {
        const idx = Main.layoutManager.primaryIndex;
        if (this._custom.length)
            return this._custom[idx] ?? this._custom[0];
        return this._group.get_child_at_index(idx) ?? this._group.get_first_child();
    }

    _customPath() {
        if (this._settings.get_string('wallpaper-source') !== 'custom')
            return null;
        const path = this._settings.get_string('wallpaper-path');
        return path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }

    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    sync() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = this._settings.get_int('wallpaper-blur') * scale;
        const brightness = 1 - this._settings.get_int('wallpaper-dim') / 100;
        const path = this._customPath();

        this._destroyCustom();
        if (path) {
            this._group.hide();
            Main.layoutManager.monitors.forEach(m => {
                const w = new St.Widget({
                    style_class: 'floww-wallpaper',
                    style: `background-image: url("${cssUri(path)}"); background-size: cover; background-position: center;`,
                    x: m.x, y: m.y, width: m.width, height: m.height,
                });
                const fx = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius, brightness});
                fx.enabled = radius > 0 || brightness < 1;
                w.add_effect_with_name('blur', fx);
                this._dialog.insert_child_above(w, this._group);
                this._custom.push(w);
            });
        } else {
            this._group.show();
            for (const w of this._group) {
                const fx = w.get_effect('blur');
                fx?.set({radius, brightness});
            }
        }
        this._onChanged?.();
    }

    _destroyCustom() {
        this._custom.forEach(w => w.destroy());
        this._custom = [];
    }

    destroy() {
        this._ids.forEach(id => this._settings.disconnect(id));
        this._group.disconnect(this._groupId);
        Main.layoutManager.disconnect(this._monitorsId);
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._destroyCustom();
        this._group.show();
        // Hand GNOME its own look back.
        try {
            this._dialog._updateBackgroundEffects?.();
        } catch {}
    }
}
