// Visualizer shown in the expanded player when there are no lyrics.
//
// Bars grow up and down from a centre line, tinted with the album palette.
// Two sources feed it:
//   • CavaSource: real audio levels from `cava` (optional dependency), run
//     only while the visualizer is on screen and music is playing.
//   • SimulatedSource: layered sines + noise, used when cava is missing or
//     turned off in preferences.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {Spring, Ticker, Presets, lerp, clamp} from '../anim/spring.js';
import {bindState} from './widgets.js';

const BARS = 32;
const MIN_LEVEL = 0.06;

export function cavaAvailable() {
    return GLib.find_program_in_path('cava') !== null;
}

function cavaConfigPath(bars) {
    const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'floww']);
    GLib.mkdir_with_parents(dir, 0o700);
    const path = GLib.build_filenamev([dir, `cava-${bars}.conf`]);
    // cava's `bars` must be even for stereo; we ask for mono and mirror
    // ourselves, which keeps the shape symmetric.
    const conf = `[general]
bars = ${bars}
framerate = 60
autosens = 1
lower_cutoff_freq = 40
higher_cutoff_freq = 12000

[input]
method = pulse
source = auto

[output]
method = raw
channels = mono
raw_target = /dev/stdout
data_format = ascii
ascii_max_range = 1000
bar_delimiter = 59
frame_delimiter = 10

[smoothing]
noise_reduction = 66
`;
    GLib.file_set_contents(path, conf);
    return path;
}

class CavaSource {
    constructor(count) {
        this.levels = new Array(count).fill(0);
        this._count = count;
        this._proc = null;
        this.failed = false;
    }

    get running() {
        return this._proc !== null;
    }

    start() {
        if (this._proc || this.failed)
            return;
        try {
            const conf = cavaConfigPath(this._count);
            this._proc = Gio.Subprocess.new(['cava', '-p', conf],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._cancellable = new Gio.Cancellable();
            this._stream = new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe()});
            this._read();
            const proc = this._proc;
            proc.wait_async(null, () => {
                // Exited on its own (no audio server, bad build…): give up
                // for this session rather than respawning in a loop.
                if (this._proc === proc) {
                    this.failed = true;
                    this._proc = null;
                }
            });
        } catch (e) {
            console.debug(`Floww Music: cava failed to start: ${e.message}`);
            this.failed = true;
            this._proc = null;
        }
    }

    _read() {
        const stream = this._stream;
        stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch {
                return; // cancelled or pipe closed
            }
            if (line === null || stream !== this._stream)
                return;
            const parts = line.split(';');
            for (let i = 0; i < this._count; i++) {
                const v = Number(parts[i]);
                if (Number.isFinite(v))
                    this.levels[i] = clamp(v / 1000, 0, 1);
            }
            this._read();
        });
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._stream = null;
        const proc = this._proc;
        this._proc = null;
        proc?.send_signal(15);
        this.levels.fill(0);
    }
}

class SimulatedSource {
    constructor(count) {
        this.levels = new Array(count).fill(0);
        this._count = count;
        this._t = Math.random() * 10;
        this._seeds = Array.from({length: count}, () => Math.random() * Math.PI * 2);
    }

    step(dt) {
        this._t += dt;
        const t = this._t;
        // A slow "beat" swell plus per-band wobble; lows are taller.
        const beat = 0.55 + 0.45 * Math.pow(Math.abs(Math.sin(t * Math.PI * 1.05)), 3);
        for (let i = 0; i < this._count; i++) {
            const f = i / this._count;
            const tilt = 1 - 0.55 * f;
            const s = this._seeds[i];
            const n = 0.5 + 0.25 * Math.sin(t * (2.1 + f * 5) + s) +
                0.15 * Math.sin(t * (5.3 + f * 3) + s * 1.7) +
                0.1 * Math.sin(t * 11.7 + s * 3.1);
            this.levels[i] = clamp(n * tilt * beat * 1.5, 0, 1);
        }
    }
}

function rgbCss([r, g, b], lift = 0) {
    const c = v => Math.round(255 * clamp(lerp(v, 1, lift), 0, 1));
    return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

export const Visualizer = GObject.registerClass(
class FlowwMusicVisualizer extends St.Widget {
    _init(state, settings, {height = 72} = {}) {
        super._init({
            style_class: 'flow-visualizer',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            height,
        });
        this._state = state;
        this._settings = settings;

        this._box = new St.BoxLayout({
            style_class: 'flow-visualizer-bars',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.FILL,
            y_expand: true,
        });
        this.add_child(this._box);
        this._bars = [];
        for (let i = 0; i < BARS; i++) {
            const bar = new St.Widget({
                style_class: 'flow-visualizer-bar',
                y_expand: true,
                y_align: Clutter.ActorAlign.FILL,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            });
            this._box.add_child(bar);
            this._bars.push({actor: bar, spring: new Spring(MIN_LEVEL, Presets.snappy, 0.002)});
        }

        // Mirror: centre bars show the bass, edges the treble.
        this._half = BARS / 2;
        this._cava = new CavaSource(this._half);
        this._sim = new SimulatedSource(this._half);
        this._env = new Spring(state.playing ? 1 : 0, Presets.gentle);

        this._ticker = new Ticker(this);
        this._ticker.add(dt => this._tick(dt));

        this._settingsId = settings.connect('changed::visualizer-cava', () => this._syncSource());
        bindState(this, state, {
            'art': () => this._paint(),
            'playback': () => {
                this._env.target = state.playing ? 1 : 0;
                this._syncSource();
                this._ticker.wake();
            },
            'heartbeat': () => this._ticker.wake(),
        });
        this.connect('notify::mapped', () => {
            this._syncSource();
            this._ticker.wake();
        });
        this.connect('destroy', () => {
            settings.disconnect(this._settingsId);
            this._cava.stop();
            this._ticker.destroy();
        });
        this._paint();
    }

    get usingCava() {
        return this._cava.running;
    }

    _wantCava() {
        return this.mapped && this._state.playing &&
            this._settings.get_boolean('visualizer-cava') && cavaAvailable();
    }

    _syncSource() {
        if (this._wantCava())
            this._cava.start();
        else
            this._cava.stop();
    }

    _paint() {
        const pal = this._state.art.palette;
        this._bars.forEach((b, i) => {
            const d = Math.abs(i - (BARS - 1) / 2) / (BARS / 2);
            const c = pal[Math.min(pal.length - 1, Math.floor(d * pal.length))];
            b.actor.set_style(`background-color: ${rgbCss(c, 0.55 - 0.2 * d)};`);
        });
    }

    _tick(dt) {
        let moving = this._env.step(dt);
        const env = clamp(this._env.value, 0, 1);
        let src;
        if (this._cava.running) {
            src = this._cava.levels;
        } else {
            this._sim.step(dt * (0.3 + 0.7 * env));
            src = this._sim.levels;
        }
        for (let i = 0; i < BARS; i++) {
            const k = Math.floor(Math.abs(i - (BARS - 1) / 2));
            const level = lerp(MIN_LEVEL, Math.max(MIN_LEVEL, src[Math.min(k, this._half - 1)]), env);
            const b = this._bars[i];
            b.spring.target = level;
            if (b.spring.step(dt))
                moving = true;
            b.actor.set_scale(1, clamp(b.spring.value, MIN_LEVEL * 0.5, 1));
        }
        return moving || (this.mapped && this._state.playing);
    }
});
