// Album art download/cache + palette extraction for the ambient background.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {request} from './http.js';

export const DEFAULT_PALETTE = [
    [0.16, 0.17, 0.24],
    [0.27, 0.20, 0.33],
    [0.13, 0.24, 0.30],
    [0.22, 0.18, 0.22],
];

function artDir() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'flow', 'art']);
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
}

function writeFile(file, data) {
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(new GLib.Bytes(data), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// Returns a local file path for the art URL (downloads once).
export async function fetchArt(url, cancellable) {
    if (!url)
        return null;
    if (url.startsWith('file://'))
        return Gio.File.new_for_uri(url).get_path();
    // Spotify sometimes still hands out the legacy open.spotify.com host.
    url = url.replace('https://open.spotify.com/image/', 'https://i.scdn.co/image/');
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
    const path = GLib.build_filenamev([artDir(), `${key}.img`]);
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        return path;
    const {status, bytes} = await request(url, {cancellable});
    if (status !== 200 || !bytes.length)
        return null;
    await writeFile(Gio.File.new_for_path(path), bytes);
    return path;
}

function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r)
            h = ((g - b) / d) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h /= 6;
        if (h < 0)
            h += 1;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
}

// Tune a colour so it reads as a rich, dark-ish backdrop under white text.
function tune([r, g, b]) {
    let [h, s, v] = rgbToHsv(r, g, b);
    s = Math.min(0.85, s * 1.15);
    v = Math.min(0.62, Math.max(0.22, v * 0.85));
    return hsvToRgb(h, s, v);
}

// Pulls up to four dominant, distinct colours from the art.
export function extractPalette(path) {
    let pix;
    try {
        pix = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 40, 40, false);
    } catch {
        return DEFAULT_PALETTE;
    }
    const data = pix.get_pixels();
    const stride = pix.get_rowstride();
    const n = pix.get_n_channels();
    const bins = new Map();
    for (let y = 0; y < pix.get_height(); y++) {
        for (let x = 0; x < pix.get_width(); x++) {
            const o = y * stride + x * n;
            const r = data[o] / 255, g = data[o + 1] / 255, b = data[o + 2] / 255;
            const [h, s, v] = rgbToHsv(r, g, b);
            // 16 hue bins for colourful pixels; 3 grey bins by brightness.
            const key = s < 0.18 ? `g${Math.min(2, Math.floor(v * 3))}` : `h${Math.floor(h * 16) % 16}`;
            const weight = (0.25 + s) * (0.3 + v);
            const bin = bins.get(key) ?? {r: 0, g: 0, b: 0, w: 0, count: 0};
            bin.r += r * weight;
            bin.g += g * weight;
            bin.b += b * weight;
            bin.w += weight;
            bin.count++;
            bins.set(key, bin);
        }
    }
    const ranked = [...bins.values()]
        .filter(b => b.count > 8)
        .sort((a, b) => b.w - a.w)
        .map(b => [b.r / b.w, b.g / b.w, b.b / b.w]);
    if (!ranked.length)
        return DEFAULT_PALETTE;
    const colors = ranked.slice(0, 4).map(tune);
    // Monochrome art: derive variations of the main colour.
    while (colors.length < 4) {
        const [h, s, v] = rgbToHsv(...colors[0]);
        const i = colors.length;
        colors.push(hsvToRgb((h + 0.04 * i) % 1, Math.min(1, s * (1 + 0.1 * i)), Math.max(0.15, v * (1 - 0.18 * i))));
    }
    return colors;
}
