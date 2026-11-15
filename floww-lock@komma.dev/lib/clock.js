// The lock screen clock. Styles:
//   stacked  date (small) above a big time, like macOS
//   classic  big time above the date
//   split    hours above minutes, date on top
//   minimal  time only

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

const KEYS = ['clock-style', 'clock-format', 'clock-size', 'clock-weight', 'clock-opacity', 'font-family', 'clock-position'];

export const LockClock = GObject.registerClass(
class FlowwLockClock extends St.BoxLayout {
    _init(settings) {
        super._init({
            style_class: 'floww-clock',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._settings = settings;
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._date = new St.Label({style_class: 'floww-clock-date'});
        this._time = new St.Label({style_class: 'floww-clock-time'});
        this._minutes = new St.Label({style_class: 'floww-clock-time'});
        for (const l of [this._date, this._time, this._minutes])
            this.add_child(l);

        this._ids = KEYS.map(k => settings.connect(`changed::${k}`, () => this._restyle()));
        this._ifaceId = this._iface.connect('changed::clock-format', () => this._tick());
        this.connect('destroy', () => {
            this._ids.forEach(id => settings.disconnect(id));
            this._iface.disconnect(this._ifaceId);
            if (this._timer)
                GLib.source_remove(this._timer);
        });
        this._restyle();
        this._schedule();
    }

    // Wake exactly at the next minute boundary.
    _schedule() {
        this._tick();
        const now = GLib.DateTime.new_now_local();
        const ms = (60 - now.get_second()) * 1000 - Math.floor(now.get_microsecond() / 1000) + 30;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(250, ms), () => {
            this._timer = 0;
            this._schedule();
            return GLib.SOURCE_REMOVE;
        });
    }

    _use24h() {
        const f = this._settings.get_string('clock-format');
        if (f === '24h')
            return true;
        if (f === '12h')
            return false;
        return this._iface.get_string('clock-format') !== '12h';
    }

    _tick() {
        const now = GLib.DateTime.new_now_local();
        const h24 = this._use24h();
        const hours = now.format(h24 ? '%H' : '%-l');
        const mins = now.format('%M');
        const style = this._settings.get_string('clock-style');
        this._date.text = now.format('%A, %B %-d');
        if (style === 'split') {
            this._time.text = hours.padStart(2, '0');
            this._minutes.text = mins;
        } else {
            this._time.text = `${hours}:${mins}`;
        }
    }

    _restyle() {
        const s = this._settings;
        const style = s.get_string('clock-style');
        const size = s.get_int('clock-size');
        const weight = s.get_int('clock-weight');
        const alpha = s.get_int('clock-opacity') / 100;
        const font = s.get_string('font-family');
        const pos = s.get_string('clock-position');
        const align = pos.endsWith('left') ? Clutter.ActorAlign.START
            : pos.endsWith('right') ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER;

        const timeCss = `font-family: ${font}; font-size: ${size}px; font-weight: ${weight}; ` +
            `color: rgba(255,255,255,${alpha}); letter-spacing: ${-size * 0.02}px;`;
        const dateCss = `font-family: ${font}; font-size: ${Math.round(Math.max(16, size * 0.19))}px; ` +
            `font-weight: ${Math.min(700, weight)}; color: rgba(255,255,255,${Math.min(1, alpha + 0.05)});`;
        this._time.set_style(timeCss);
        this._minutes.set_style(timeCss);
        this._date.set_style(dateCss);
        for (const l of [this._date, this._time, this._minutes])
            l.x_align = align;

        // Order and visibility per style.
        this.remove_all_children();
        if (style === 'classic') {
            this.add_child(this._time);
            this.add_child(this._date);
        } else if (style === 'minimal') {
            this.add_child(this._time);
        } else if (style === 'split') {
            this.add_child(this._date);
            this.add_child(this._time);
            this.add_child(this._minutes);
        } else {
            this.add_child(this._date);
            this.add_child(this._time);
        }
        // Pull the minutes up under the hours (St has no negative margins or
        // line-height, so this is a paint-only nudge).
        this._minutes.translation_y = style === 'split' ? Math.round(-size * 0.22) : 0;
        this._tick();
    }
});
