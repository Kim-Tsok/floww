// The lock screen clock. Styles:
//   stacked  date (small) above a big time, like macOS
//   classic  big time above the date
//   split    hours above minutes, date on top
//   minimal  time only
// Lettering (clock-font):
//   apple    the iOS / macOS lock screen look: heavy, tightly tracked SF
//            (SF Pro Rounded when installed)
//   glass    the same shapes as liquid glass (see glassText.js)
//   sf       plain SF Pro at the chosen weight

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {GlassTextEffect} from './glassText.js';
import {Ease, Dur} from './motion.js';

const KEYS = ['clock-style', 'clock-format', 'clock-size', 'clock-weight', 'clock-opacity',
    'font-family', 'clock-position', 'clock-font'];
const APPLE_FONT = '"SF Pro Rounded", "SF Pro Display", "SF Pro", Inter Display, Inter, Cantarell, sans-serif';

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
        for (const l of [this._time, this._minutes]) {
            l.set_pivot_point(0.5, 0.5);
            l.connect('notify::allocation', () => this._syncGlass(l));
        }

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

    _tick(animate = true) {
        const now = GLib.DateTime.new_now_local();
        const h24 = this._use24h();
        const hours = now.format(h24 ? '%H' : '%-l');
        const mins = now.format('%M');
        const style = this._settings.get_string('clock-style');
        this._setText(this._date, now.format('%A, %B %-d'), animate);
        if (style === 'split') {
            this._setText(this._time, hours.padStart(2, '0'), animate);
            this._setText(this._minutes, mins, animate);
        } else {
            this._setText(this._time, `${hours}:${mins}`, animate);
        }
    }

    // The minute rolls over with a soft drop: old digits sink and fade, new
    // ones settle in from above.
    _setText(label, text, animate) {
        if (label.text === text)
            return;
        if (!animate || !label.mapped || !label.text) {
            label.text = text;
            return;
        }
        const d = Math.max(4, Math.round(this._settings.get_int('clock-size') * 0.05));
        const base = label._flowwBaseY ?? 0;
        label.remove_all_transitions();
        label.ease({
            opacity: 0, translation_y: base + d, duration: Dur.fast, mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                label.text = text;
                label.translation_y = base - d;
                label.ease({opacity: 255, translation_y: base, duration: Dur.slow, mode: Ease.enter});
            },
        });
    }

    _syncGlass(label) {
        const fx = label.get_effect('floww-glass-text');
        if (!fx)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const box = label.get_allocation_box();
        fx.setParams({
            width: Math.round(box.get_width() * scale),
            height: Math.round(box.get_height() * scale),
            body: 0.12 + 0.1 * (this._settings.get_int('clock-opacity') / 100),
        });
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

        const lettering = s.get_string('clock-font');
        const glass = lettering === 'glass';
        let timeFont = font, timeWeight = weight, tracking = -size * 0.02;
        if (lettering !== 'sf') {
            timeFont = APPLE_FONT;
            timeWeight = glass ? 800 : Math.max(weight, 700);
            tracking = -size * 0.045;
        }
        // Glass needs opaque white letters with no shadow: the effect turns
        // their shape into glass and handles the opacity itself.
        const timeCss = `font-family: ${timeFont}; font-size: ${size}px; font-weight: ${timeWeight}; ` +
            `letter-spacing: ${tracking}px; ` +
            (glass ? 'color: #fff; text-shadow: none;' : `color: rgba(255,255,255,${alpha});`);
        const dateFont = lettering === 'sf' ? font : APPLE_FONT;
        const dateCss = `font-family: ${dateFont}; font-size: ${Math.round(Math.max(16, size * 0.18))}px; ` +
            `font-weight: ${lettering === 'sf' ? Math.min(700, weight) : 600}; ` +
            `color: rgba(255,255,255,${Math.min(1, alpha + 0.05)});`;
        this._time.set_style(timeCss);
        this._minutes.set_style(timeCss);
        this._date.set_style(dateCss);
        for (const l of [this._time, this._minutes]) {
            const has = !!l.get_effect('floww-glass-text');
            if (glass && !has)
                l.add_effect_with_name('floww-glass-text', new GlassTextEffect());
            else if (!glass && has)
                l.remove_effect_by_name('floww-glass-text');
            l.opacity = 255;
            this._syncGlass(l);
        }
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
        this._minutes._flowwBaseY = style === 'split' ? Math.round(-size * 0.22) : 0;
        this._minutes.translation_y = this._minutes._flowwBaseY;
        this._tick(false);
    }
});
