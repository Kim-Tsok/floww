// LRCLIB (https://lrclib.net) — free, open, no auth. Primary lyrics source.

import {getJson, query} from '../http.js';
import {parseLrc, parsePlain} from './lrc.js';

const API = 'https://lrclib.net/api';
const REQUEST_TIMEOUT_MS = 5000;

// "Song - Remastered 2011", "Song (feat. X)", "Song - Live at …" → "Song"
export function cleanTitle(title) {
    return title
        .replace(/\s*[([][^)\]]*(feat\.|ft\.|with |remaster|live|version|edit|mono|stereo|deluxe)[^)\]]*[)\]]/ig, '')
        .replace(/\s+-\s+.*(remaster|live|version|edit|mono|stereo|mix|from|demo).*$/i, '')
        .trim();
}

function toResult(item, track) {
    if (!item)
        return null;
    if (item.instrumental)
        return {kind: 'instrumental', source: 'LRCLIB'};
    if (item.syncedLyrics) {
        const lines = parseLrc(item.syncedLyrics, track.length / 1e6);
        if (lines.some(l => !l.interlude))
            return {kind: 'synced', lines, source: 'LRCLIB'};
    }
    if (item.plainLyrics)
        return {kind: 'plain', plain: parsePlain(item.plainLyrics), source: 'LRCLIB'};
    return null;
}

async function getExact(track, title, cancellable) {
    const {status, json} = await getJson(`${API}/get?${query({
        track_name: title,
        artist_name: track.mainArtist || track.artist,
        album_name: track.album,
        duration: Math.round(track.length / 1e6) || undefined,
    })}`, {cancellable, timeoutMs: REQUEST_TIMEOUT_MS});
    if (status === 404)
        return null;
    return toResult(json, track);
}

async function search(track, title, cancellable) {
    const {json} = await getJson(`${API}/search?${query({
        track_name: title,
        artist_name: track.mainArtist || track.artist,
    })}`, {cancellable, timeoutMs: REQUEST_TIMEOUT_MS});
    if (!Array.isArray(json) || !json.length)
        return null;
    const dur = track.length / 1e6;
    const close = json.filter(i => !dur || !i.duration || Math.abs(i.duration - dur) <= 3);
    const pick = close.find(i => i.syncedLyrics) ?? close.find(i => i.plainLyrics) ?? close.find(i => i.instrumental);
    return toResult(pick, track);
}

function pickBest(results) {
    return results.find(r => r?.kind === 'synced') ??
        results.find(r => r?.kind === 'instrumental') ??
        results.find(r => r) ?? null;
}

// Two rounds instead of four sequential requests: exact lookups for every
// title variant in parallel, then searches in parallel only if needed.
// Network errors propagate so the caller can tell "offline" from "none".
export async function fetchLrclib(track, cancellable) {
    const titles = [...new Set([track.title, cleanTitle(track.title)])].filter(Boolean);
    const exact = await Promise.all(titles.map(t => getExact(track, t, cancellable)));
    const first = pickBest(exact);
    if (first?.kind === 'synced' || first?.kind === 'instrumental')
        return first;
    const found = await Promise.all(titles.map(t => search(track, t, cancellable)));
    return pickBest([...found, first]);
}
