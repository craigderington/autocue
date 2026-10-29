# Omarchy Teleprompter

A simple local teleprompter for reading scripts at your own pace. Import a file, adjust the reading speed, and press **Space**. The interface follows your active Omarchy theme automatically.

## Run

Requires **Python 3.11+**. For PDF import, install Poppler (`sudo pacman -S poppler` on Omarchy). No Python or JavaScript packages need installing.

```sh
make run
# or: python3 server.py
```

Open **http://localhost:3400**. Keep the terminal running; press Ctrl+C to stop. To choose a different port: `python3 server.py --port 3500`.

## Read a script

- **Import script** or drag a file onto the window: Word `.docx`, text-based `.pdf`, UTF-8/UTF-16 `.txt`, `.md`, or `.markdown`. Maximum file size: 10 MB; extracted text: 200,000 characters.
- **Edit script** to paste text or adjust the imported wording. Importing or applying edits starts a fresh take.
- Set **40–300 words per minute**, adjust text size, or enable horizontal mirroring for a teleprompter reflector.
- Use the timeline or scroll the reading area to reposition. Manual scrolling pauses playback. Playback also pauses when the browser tab is hidden.
- **Fullscreen** keeps the script and cue visible. Keyboard controls work there too.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ↑ / ↓ | Change speed by 5 WPM |
| R | Restart |
| M | Mirror |
| F | Toggle fullscreen |
| Esc | Pause / leave fullscreen |

Markdown’s common formatting markers are removed for reading. Word import reads body paragraphs and tables; embedded images, headers, comments, and text inside images are excluded. Older `.doc` files must be saved as `.docx`. Scanned PDFs need OCR first. Complex PDF columns may require editing after import.

Scripts stay on your machine. The server binds to `127.0.0.1`, processes imports locally, and deletes PDF temporary files after extraction. Scripts are kept only in the current page and are lost on reload. Only speed, text size, and mirror preferences are saved in browser local storage. There are no analytics, external fonts, or CDN dependencies.

## Omarchy themes

The app checks the following paths every 1.5 seconds, so theme changes apply during playback:

1. `$XDG_STATE_HOME/omarchy/current/theme/colors.toml` (defaults to `~/.local/state/...`).
2. `$XDG_CONFIG_HOME/omarchy/current/theme/colors.toml` (defaults to `~/.config/...`, for older installations).

It reads background, foreground, accent, theme name, and light/dark mode. It never modifies your desktop configuration. Without a theme, the interface explicitly shows **Tokyo Night · fallback**. These locations follow [Omarchy’s theme activation documentation](https://github.com/omacom/omarchy/blob/quattro/docs/theming.md).

For a custom location or testing:

```sh
OMARCHY_THEME_DIR=/path/to/theme python3 server.py
```

## Development

- `public/` — browser UI, styles, and playback logic; no build step.
- `server.py` — local HTTP server, document extraction, and theme reader.
- `tests/` — standard-library unit and HTTP integration tests.
- `make test` — run extraction, theme, and server tests.
- `make check` — check Python and JavaScript syntax (requires Node.js for JS).

Use four-space Python indentation and two-space JavaScript indentation. Keep browser content as text rather than injecting imported HTML. Test changes to import handling and playback in the browser.
