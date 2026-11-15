import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const USER_AGENT = 'Flow-GNOME-Shell-Extension/1.0';

let _session = null;

export function session() {
    if (!_session) {
        _session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: 12,
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

// Returns {status, bytes: Uint8Array}
export function request(url, {headers = {}, cancellable = null} = {}) {
    const msg = Soup.Message.new('GET', url);
    if (!msg)
        return Promise.reject(new Error(`Bad URL ${url}`));
    for (const [k, v] of Object.entries(headers))
        msg.request_headers.replace(k, v);
    return new Promise((resolve, reject) => {
        session().send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                resolve({status: msg.get_status(), bytes: bytes.get_data() ?? new Uint8Array()});
            } catch (e) {
                reject(e);
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
