// Lyrics model + LRC / enhanced-LRC parsing.
//
// A parsed lyric document is:
//   {synced: bool, lines: [Line]}
//   Line = {start, end, text, interlude, words: [{start, end, charStart, charEnd}]}
// Times are seconds. `words` always exists for synced text lines: real word
// timings from enhanced LRC / Spotify syllables when available, otherwise a
// synthesized estimate so the karaoke fill still flows naturally.

const LINE_TS = /^\[(\d+):(\d+(?:[.:]\d+)?)\]/;
const WORD_TS = /<(\d+):(\d+(?:[.:]\d+)?)>/g;
const OFFSET_TAG = /^\[offset:\s*([+-]?\d+)\s*\]/i;

const INTERLUDE_MIN = 3.5; // seconds of silence that earn the breathing dots

function toSec(min, sec) {
    return Number(min) * 60 + Number(String(sec).replace(':', '.'));
}

// Splits "<00:01.00>Hello <00:01.50>world" into plain text + word stamps.
function parseEnhanced(rest) {
    if (!/<\d+:\d+/.test(rest))
        return {text: rest.trim(), stamps: null};
    const stamps = [];
    let text = '';
    let last = 0;
    let pendingStart = null;
    WORD_TS.lastIndex = 0;
    let m;
    while ((m = WORD_TS.exec(rest))) {
        const chunk = rest.slice(last, m.index);
        if (pendingStart !== null && chunk.length) {
            const charStart = text.length;
            text += chunk;
            stamps.push({start: pendingStart, charStart, charEnd: text.length});
        } else {
            text += chunk;
        }
        pendingStart = toSec(m[1], m[2]);
        last = m.index + m[0].length;
    }
    const tail = rest.slice(last);
    if (tail.length) {
        const charStart = text.length;
        text += tail;
        stamps.push({start: pendingStart ?? 0, charStart, charEnd: text.length});
    } else if (stamps.length && pendingStart !== null) {
        // Trailing stamp marks the end of the last word.
        stamps[stamps.length - 1].endHint = pendingStart;
    }
    // Trim leading whitespace while keeping char offsets consistent.
    const lead = text.length - text.trimStart().length;
    const trimmed = text.trim();
    for (const s of stamps) {
        s.charStart = Math.max(0, s.charStart - lead);
        s.charEnd = Math.min(trimmed.length, Math.max(s.charStart, s.charEnd - lead));
    }
    return {text: trimmed, stamps};
}

// Estimates per-word timing for a line that only has a start/end.
// Singing rarely spans the whole gap to the next line, so we fill a bit
// faster than the gap and let the line rest fully lit before moving on.
export function synthesizeWords(line) {
    const {text, start, end} = line;
    const tokens = [];
    const re = /\S+\s*/g;
    let m;
    while ((m = re.exec(text)))
        tokens.push({charStart: m.index, charEnd: m.index + m[0].length, len: m[0].trimEnd().length});
    if (!tokens.length)
        return [];
    const chars = tokens.reduce((n, t) => n + t.len, 0);
    const gap = Math.max(0.3, end - start);
    const sung = Math.min(gap * 0.92, Math.max(0.8, chars * 0.1 + 0.35));
    let t = start;
    return tokens.map(tok => {
        const d = sung * (tok.len / chars);
        const w = {start: t, end: t + d, charStart: tok.charStart, charEnd: tok.charEnd};
        t += d;
        return w;
    });
}

// Final pass shared by every source: sort, compute ends, mark interludes,
// add an intro interlude, attach word timings.
export function finalizeLines(raw, trackLength = 0) {
    const lines = raw
        .filter(l => Number.isFinite(l.start))
        .sort((a, b) => a.start - b.start);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const next = lines[i + 1];
        const end = l.end && l.end > l.start
            ? l.end
            : next ? next.start : Math.max(l.start + 4, trackLength || 0);
        const text = (l.text ?? '').trim();
        const isMusicNote = /^[♪♫♬\s]*$/.test(text);
        if (!text || isMusicNote) {
            if (end - l.start >= INTERLUDE_MIN)
                out.push({start: l.start, end, text: '', interlude: true, words: []});
            continue;
        }
        out.push({start: l.start, end, text, interlude: false, stamps: l.stamps ?? null});
    }

    // Explicit gaps between lines (Spotify gives real end times).
    const withGaps = [];
    for (let i = 0; i < out.length; i++) {
        withGaps.push(out[i]);
        const next = out[i + 1];
        if (next && !out[i].interlude && !next.interlude && next.start - out[i].end >= INTERLUDE_MIN)
            withGaps.push({start: out[i].end, end: next.start, text: '', interlude: true, words: []});
    }

    if (withGaps.length && withGaps[0].start >= 4 && !withGaps[0].interlude)
        withGaps.unshift({start: 0, end: withGaps[0].start, text: '', interlude: true, words: []});

    for (const l of withGaps) {
        if (l.interlude)
            continue;
        if (l.stamps?.length) {
            l.words = l.stamps.map((s, i) => ({
                start: s.start,
                end: l.stamps[i + 1]?.start ?? s.endHint ?? Math.min(l.end, s.start + 1.2),
                charStart: s.charStart,
                charEnd: s.charEnd,
            }));
        } else {
            l.words = synthesizeWords(l);
        }
        delete l.stamps;
    }
    return withGaps;
}

export function parseLrc(source, trackLength = 0) {
    let offset = 0;
    const raw = [];
    for (const rawLine of source.split(/\r?\n/)) {
        let rest = rawLine.trim();
        const off = OFFSET_TAG.exec(rest);
        if (off) {
            offset = Number(off[1]) / 1000;
            continue;
        }
        const starts = [];
        let m;
        while ((m = LINE_TS.exec(rest))) {
            starts.push(toSec(m[1], m[2]));
            rest = rest.slice(m[0].length);
        }
        if (!starts.length)
            continue;
        const {text, stamps} = parseEnhanced(rest);
        for (const s of starts) {
            raw.push({
                start: s - offset,
                text,
                stamps: stamps?.map(w => ({...w, start: w.start - offset,
                    endHint: w.endHint !== undefined ? w.endHint - offset : undefined})) ?? null,
            });
        }
    }
    return finalizeLines(raw, trackLength);
}

export function parsePlain(source) {
    return source.split(/\r?\n/).map(t => t.trim());
}

// Index of the line playing at time t (binary search), or -1 before the first.
export function lineIndexAt(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].start <= t) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

// Continuous character position (float) sung so far in `line` at time t.
export function sungChars(line, t) {
    const words = line.words;
    if (!words?.length)
        return t >= line.start ? line.text.length : 0;
    if (t < words[0].start)
        return words[0].charStart;
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (t < w.start)
            return words[i - 1]?.charEnd ?? w.charStart;
        if (t < w.end) {
            const p = (t - w.start) / Math.max(0.001, w.end - w.start);
            // Slight ease so each word "blooms" rather than wiping linearly.
            const e = 1 - Math.pow(1 - p, 1.6);
            return w.charStart + (w.charEnd - w.charStart) * e;
        }
    }
    return line.text.length;
}
