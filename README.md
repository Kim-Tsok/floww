# Flow

Spotify with Apple Music–style synced lyrics, for GNOME Shell 50.

- **Desktop widget** is a floating card that sits under your windows. Drag it anywhere.
- **Top bar pill** is an adaptive "island" that shows album art and equalizer bars. It springs wider to show the current lyric line. Click it to open the full card.
- **Lock screen** shows a card under the clock. Click it to expand into full-screen immersive lyrics.

## Install (development)

```sh
ln -s "$PWD/flow@komma.dev" ~/.local/share/gnome-shell/extensions/flow@komma.dev
glib-compile-schemas flow@komma.dev/schemas
# Wayland: log out and back in so GNOME Shell discovers the extension, then:
gnome-extensions enable flow@komma.dev
gnome-extensions prefs flow@komma.dev   # settings
```

After changing code you need to log out and back in, because GNOME Shell can't reload extension modules.

## Lyrics

1. **[LRCLIB](https://lrclib.net)** is the default source. It's free, needs no account, and lyrics are line-synced, sometimes word-synced.
2. **Spotify's own lyrics** are an optional fallback, off by default. To use them, enable the fallback in preferences and paste your `sp_dc` cookie. The cookie is stored in the GNOME keyring. This endpoint is unofficial and may break.

Lyrics and album art are cached in `~/.cache/flow/`.

## Testing without touching your session

`tools/fake-spotify.js` is a fake Spotify MPRIS player that you can run against a headless shell:

```sh
dbus-run-session -- bash -c '
  XDG_DATA_HOME=/tmp/flow-test GSETTINGS_BACKEND=memory \
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x1000 &
  sleep 5
  gjs -m tools/fake-spotify.js 55 /path/to/art.png /tmp/flow-ctl &
  gnome-extensions enable flow@komma.dev
  wait'
```

To control the fake player, write `pause`, `next` or `seek 90` into the control file.

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
lib/ui/*.js             card, pill, desktop widget, lock screen
```
