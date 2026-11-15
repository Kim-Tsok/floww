// Keeps the screen awake while lyrics are on screen full size.
//
// Uses gnome-session's idle inhibitor, the same thing video players use:
// the session never turns "idle", so the screen neither dims, blanks nor
// auto-locks (and on the lock screen, the shield never fades to black).
//
// One shared cookie, reference counted by holder, so the desktop view and
// the lock screen can't release each other's hold.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS = 'org.gnome.SessionManager';
const PATH = '/org/gnome/SessionManager';
const IFACE = 'org.gnome.SessionManager';
const FLAG_IDLE = 8;

const holders = new Set();
let cookie = 0;
let pending = false;

function call(method, params, type, cb) {
    Gio.DBus.session.call(BUS, PATH, IFACE, method, params,
        type ? new GLib.VariantType(type) : null,
        Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
            try {
                cb?.(conn.call_finish(res));
            } catch (e) {
                console.debug(`Floww Music: ${method} failed: ${e.message}`);
                cb?.(null);
            }
        });
}

function sync() {
    const want = holders.size > 0;
    if (want && !cookie && !pending) {
        pending = true;
        call('Inhibit', new GLib.Variant('(susu)', ['floww-music', 0, 'Lyrics are playing full screen', FLAG_IDLE]),
            '(u)', reply => {
                pending = false;
                cookie = reply ? reply.deepUnpack()[0] : 0;
                sync(); // released while we were waiting?
            });
    } else if (!want && cookie && !pending) {
        const c = cookie;
        cookie = 0;
        call('Uninhibit', new GLib.Variant('(u)', [c]), null, null);
    }
}

export function holdAwake(holder, on) {
    if (on)
        holders.add(holder);
    else
        holders.delete(holder);
    sync();
}

export function releaseAll() {
    holders.clear();
    sync();
}
