# Floww Music

Spotify with Apple Music–style synced lyrics, for GNOME Shell 50.

A companion extension, **Floww Lock** (`floww-lock@komma.dev`, coming next), will replace the lock screen with a customizable macOS-style liquid-glass design and host Floww Music's player. While Floww Lock is enabled, Floww Music leaves the lock screen to it.

- **Desktop widget** is a floating card that sits under your windows. Drag it anywhere.
- **Top bar pill** is an adaptive "island" that shows album art and equalizer bars. It springs wider to show the current lyric line. Hover it for the title and controls (shuffle, previous, play/pause, next, repeat, DJ). Click it to open the full card.
- **Lock screen** shows the card at the top of the notification list, so it never overlaps notifications. Click it to expand into full-screen immersive lyrics.
- **Controls** everywhere: shuffle, previous, play/pause, next, repeat (off → all → one) and Spotify DJ. DJ opens Spotify's DJ playlist and only works on accounts that have DJ.

## Install (development)

```sh
ln -s "$PWD/floww-music@komma.dev" ~/.local/share/gnome-shell/extensions/floww-music@komma.dev
glib-compile-schemas floww-music@komma.dev/schemas
# Wayland: log out and back in so GNOME Shell discovers the extension, then:
gnome-extensions enable floww-music@komma.dev
gnome-extensions prefs floww-music@komma.dev   # settings
```

After changing code you need to log out and back in, because GNOME Shell can't reload extension modules.

## Lyrics

1. **[LRCLIB](https://lrclib.net)** is the default source. It's free, needs no account, and lyrics are line-synced, sometimes word-synced.
2. **Spotify's own lyrics** are an optional fallback, off by default. To use them, enable the fallback in preferences and paste your `sp_dc` cookie. The cookie is stored in the GNOME keyring. This endpoint is unofficial and may break.

Lyrics and album art are cached in `~/.cache/floww/`.

**Offline and slow networks.** If the machine has no network, Floww Music says so immediately. Otherwise each request gives up after 5 s and a whole lookup after 8 s, and you see "You're offline" instead of waiting. Offline results are never cached. Lyrics load on their own when the network comes back, and there is a small refresh button to try again by hand.

**Album art** shows a 64 px thumbnail first (a few KB, nearly instant), then swaps to the 300 px version. If art can't be downloaded you see a placeholder, never the previous song's cover.

## Visualizer

When a song has no lyrics (or you're offline), the expanded player shrinks the lyrics area and shows a visualizer. With [cava](https://github.com/karlstav/cava) installed (`sudo dnf install cava`), the bars follow the actual audio. cava runs only while the visualizer is visible and music is playing. Without cava, or with "Live visualizer with cava" turned off in preferences, the bars are simulated.

## Testing without touching your session

`tools/fake-spotify.js` is a fake Spotify MPRIS player that you can run against a headless shell:

```sh
dbus-run-session -- bash -c '
  XDG_DATA_HOME=/tmp/flow-test GSETTINGS_BACKEND=memory \
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x1000 &
  sleep 5
  gjs -m tools/fake-spotify.js 55 /path/to/art.png /tmp/flow-ctl &
  gnome-extensions enable floww-music@komma.dev
  wait'
```

To control the fake player, write `pause`, `next`, `seek 90` or `nolyrics` (switch to a song with no lyrics) into the control file. It also supports shuffle, repeat and `OpenUri`.

## Layout

```
extension.js            session-mode switching (user ⇄ lock)
lib/playerState.js      shared state + smooth position clock
lib/mpris.js            Spotify MPRIS client
lib/lyrics/             LRC parser, LRCLIB, Spotify fallback, cache
lib/art.js              art download + palette extraction
lib/anim/spring.js      spring physics + frame ticker
lib/ui/effects.js       GLSL: karaoke fill, edge fade, ambient gradient
lib/ui/lyricsView.js    the lyrics renderer used everywhere
lib/ui/visualizer.js    no-lyrics visualizer (cava or simulated)
lib/ui/*.js             card, pill, desktop widget, lock screen
```
