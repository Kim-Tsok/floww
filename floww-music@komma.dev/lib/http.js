import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const USER_AGENT = 'Floww-Music-GNOME-Shell-Extension/1.0';

let _session = null;

export function session() {
    if (!_session) {
        _session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: 6,
            max_conns_per_host: 4,
        });
    }
    return _session;
}

export function destroySession() {
    _session?.abort();
    _session = null;
}

export function query(params) {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

export class TimeoutError extends Error {
    constructor(url) {
        super(`Timed out: ${url}`);
        this.name = 'TimeoutError';
    }
}

// Returns {status, bytes: Uint8Array}. `timeoutMs` bounds the whole request
// (connect + transfer), not just idle time, so a crawling network can't hang
// us; on expiry the request is cancelled and rejects with TimeoutError.
export function request(url, {headers = {}, cancellable = null, timeoutMs = 0} = {}) {
    const msg = Soup.Message.new('GET', url);
    if (!msg)
        return Promise.reject(new Error(`Bad URL ${url}`));
    for (const [k, v] of Object.entries(headers))
        msg.request_headers.replace(k, v);

    // Our own cancellable so a timeout never cancels the caller's.
    const own = new Gio.Cancellable();
    let parentId = 0;
    if (cancellable)
        parentId = cancellable.connect(() => own.cancel()); // g_cancellable_connect
    let timedOut = false;
    let timerId = 0;
    if (timeoutMs > 0) {
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timerId = 0;
            timedOut = true;
            own.cancel();
            return GLib.SOURCE_REMOVE;
        });
    }
    const cleanup = () => {
        if (timerId)
            GLib.source_remove(timerId);
        timerId = 0;
        if (parentId)
            cancellable.disconnect(parentId);
        parentId = 0;
    };

    return new Promise((resolve, reject) => {
        session().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, own, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                cleanup();
                resolve({status: msg.get_status(), bytes: bytes.get_data() ?? new Uint8Array()});
            } catch (e) {
                cleanup();
                reject(timedOut && !cancellable?.is_cancelled() ? new TimeoutError(url) : e);
            }
        });
    });
}

export async function getJson(url, opts) {
    const {status, bytes} = await request(url, opts);
    if (status < 200 || status >= 300)
        return {status, json: null};
    try {
        return {status, json: JSON.parse(new TextDecoder().decode(bytes))};
    } catch {
        return {status, json: null};
    }
}
