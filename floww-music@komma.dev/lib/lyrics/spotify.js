// OPTIONAL, UNOFFICIAL: Spotify's own web-player lyrics endpoint.
//
// Only used when the user enabled it and stored their `sp_dc` cookie in the
// keyring from the preferences. Spotify changes this API without notice, so
// everything here fails soft: any error just means "no lyrics from Spotify".

import Gio from 'gi://Gio';
import Secret from 'gi://Secret';
import {getJson} from '../http.js';
import {finalizeLines} from './lrc.js';

export const SECRET_SCHEMA = new Secret.Schema('dev.komma.Flow',
    Secret.SchemaFlags.NONE, {key: Secret.SchemaAttributeType.STRING});

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

let _token = null; // {value, expires}

function lookupCookie(cancellable) {
    return new Promise(resolve => {
        Secret.password_lookup(SECRET_SCHEMA, {key: 'sp_dc'}, cancellable, (o, res) => {
            try {
                resolve(Secret.password_lookup_finish(res));
            } catch {
                resolve(null);
            }
        });
    });
}

async function getToken(cancellable) {
    if (_token && _token.expires > Date.now() + 60_000)
        return _token.value;
    const spDc = await lookupCookie(cancellable);
    if (!spDc)
        return null;
    const {json} = await getJson('https://open.spotify.com/api/token?reason=transport&productType=web-player', {
        headers: {'Cookie': `sp_dc=${spDc}`, 'User-Agent': BROWSER_UA, 'App-Platform': 'WebPlayer'},
        cancellable,
        timeoutMs: 5000,
    });
    if (!json?.accessToken || json.isAnonymous)
        return null;
    _token = {value: json.accessToken, expires: Number(json.accessTokenExpirationTimestampMs) || Date.now() + 30 * 60_000};
    return _token.value;
}

export async function fetchSpotify(track, cancellable) {
    if (!/^[A-Za-z0-9]{22}$/.test(track.id))
        return null;
    try {
        const token = await getToken(cancellable);
        if (!token)
            return null;
        const {status, json} = await getJson(
            `https://spclient.wg.spotify.com/color-lyrics/v2/track/${track.id}?format=json&vocalRemoval=false&market=from_token`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'App-Platform': 'WebPlayer',
                    'User-Agent': BROWSER_UA,
                },
                cancellable,
                timeoutMs: 5000,
            });
        if (status === 401)
            _token = null;
        const lyr = json?.lyrics;
        if (!lyr?.lines?.length)
            return null;
        if (lyr.syncType === 'UNSYNCED')
            return {kind: 'plain', plain: lyr.lines.map(l => l.words), source: 'Spotify'};
        const raw = lyr.lines.map(l => {
            const start = Number(l.startTimeMs) / 1000;
            const endMs = Number(l.endTimeMs);
            return {start, end: endMs > 0 ? endMs / 1000 : 0, text: l.words};
        });
        return {kind: 'synced', lines: finalizeLines(raw, track.length / 1e6), source: 'Spotify'};
    } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.debug(`Floww Music: Spotify lyrics unavailable: ${e.message}`);
        return null;
    }
}
