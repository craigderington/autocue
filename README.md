# autocue

A simple local teleprompter for reading scripts at your own pace. Import a file, adjust the reading speed, and press **Space**. The interface follows your active Omarchy theme automatically.

## Run

Requires **Python 3.11+**. For PDF import, install Poppler (`sudo pacman -S poppler` on Omarchy). Running the app needs no Python or JavaScript packages.

```sh
make run
# or: python3 server.py
```

Open **<http://localhost:3400>**. Keep the terminal running; press Ctrl+C to stop. To choose a different port: `python3 server.py --port 3500`.

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

## Record a take

1. Select **Enable camera** and allow camera and microphone access in the browser. The live thumbnail lets you frame your shot without starting a recording.
2. Select **Record take**, then start or pause script scrolling whenever you need. Recording runs independently of playback, including in fullscreen.
3. Select **Stop recording**. Both devices turn off once the video finishes encoding. Select **Review take** to watch it, then **Download** to save it locally.

The download uses a format supported by your browser (`.webm` or `.mp4`) and includes camera video and microphone audio. It does not include the script or application UI. The live camera thumbnail is mirrored for framing; script mirroring and the thumbnail do not mirror the saved video.

Footage stays in browser memory and is never sent to the local server or an external service. Download it before leaving or reloading the page. Only the most recent completed take is retained; it stays available until the next take finishes. Takes stop automatically at **15 minutes or 256 MiB**, whichever comes first. If a device disconnects, available footage is finalized for download.

Camera capture requires `localhost` or HTTPS. Permission errors appear beside the controls; if access was denied, enable both devices in the browser's site settings and retry. Keep the tab open and in the foreground while recording; browser or operating-system background restrictions can interrupt capture.

## Omarchy themes

The app checks the following paths every 1.5 seconds, so theme changes apply during playback:

1. `$XDG_STATE_HOME/omarchy/current/theme/colors.toml` (defaults to `~/.local/state/...`).
2. `$XDG_CONFIG_HOME/omarchy/current/theme/colors.toml` (defaults to `~/.config/...`, for older installations).

It reads background, foreground, accent, theme name, and light/dark mode. Older themes with only `alacritty.toml` are also supported. It never modifies your desktop configuration. Without a theme, the interface explicitly shows **Tokyo Night · fallback**. These locations follow [Omarchy’s theme activation documentation](https://github.com/omacom/omarchy/blob/quattro/docs/theming.md).

For a custom location or testing:

```sh
OMARCHY_THEME_DIR=/path/to/theme python3 server.py
```

## Development

- `public/` — browser UI, styles, playback, and camera recording; no build step.
- `server.py` — local HTTP server, document extraction, and theme reader.
- `tests/` — standard-library unit and HTTP integration tests.
- `e2e/` — Playwright browser tests using an isolated local server and theme fixtures.
- `make test` — run extraction, theme, HTTP handler, playback, and recording tests (requires Node.js 22+; HTTP tests use in-memory connections).
- `make check` — check Python and JavaScript syntax (requires Node.js for JS).
- `make test-browser` — run the browser matrix after the development setup below.

Use four-space Python indentation and two-space JavaScript indentation. Keep browser content as text rather than injecting imported HTML. Test changes to import handling and playback in the browser.

### Cross-browser verification

Install the pinned development dependencies and matching browsers:

```sh
npm ci
npx playwright install chromium firefox webkit
make test-browser
```

The suite starts its own server on **127.0.0.1:3417**. Keep that port available. It uses generated scripts and theme files under `.browser-test-state/`; it never changes or reads your desktop theme. Poppler is required for the PDF browser checks.

The matrix covers Chromium, Firefox, WebKit, and emulated Pixel 7 and iPhone 13 profiles. It checks imports through the real server, playback timing, pause/resume, keyboard controls, seeking, resizing, mirroring, editing, safe text rendering, saved preferences, theme switching, connection recovery, dialogs, and fullscreen. Device fullscreen checks are explicitly skipped when the browser does not support it. Mobile emulation and WebKit coverage do not replace testing on physical devices or released Safari.

Recording tests use synthetic video/audio streams with each engine's real encoder, then download and decode the result. Chromium and Firefox also exercise native `getUserMedia` with their synthetic-device settings. Permission denial, cancelled requests, disconnects, cleanup, take replacement, and fullscreen recording are covered. Automated tests never open your real camera or microphone; actual device framing and microphone quality still need a physical-device check.

The pinned Linux WebKit build does not expose `MediaRecorder`, so its encoding tests explicitly skip and its unavailable-feature UI is verified instead. These skips are reported separately from passing checks. Native Safari/iOS recording remains a manual verification item; format selection includes MP4 for browsers that support it.

```sh
npm run test:browser:list                 # Validate configuration and list cases; does not run browsers
npm run test:browser -- --project=firefox # Run one engine
npx playwright show-report               # Review results after a run
```

Failures retain screenshots and traces. Each profile also captures a default reading-view screenshot for visual review. Generated reports, fixtures, and `node_modules/` are ignored by Git.

`.github/workflows/verify.yml` runs syntax/unit checks and the browser matrix on Ubuntu with Poppler and browser system dependencies installed. This is the reproducible path for the complete matrix when local browser dependencies are unavailable. The workflow runs after the changes are pushed to GitHub; adding the file does not run CI by itself.

On Omarchy, Playwright's Ubuntu WebKit build can require library versions that differ from Arch's. Run the complete matrix in the supplied Ubuntu test container to keep those dependencies separate from your desktop:

```sh
make test-browser-docker
# One engine or spec:
make test-browser-docker BROWSER_TEST_ARGS="e2e/recording.spec.js --project=webkit"
```

This requires Docker and downloads the matching Playwright image on the first build. It includes Python, Poppler, and the pinned Node development dependencies. The tests run as non-root UID 1000; the host report directories must be writable by that UID. Reports and screenshots are saved to `playwright-report/` and `test-results/`. The test server stays inside the container with no published ports. Keep the Dockerfile's Playwright version in sync with `package-lock.json` when upgrading.

Browser execution requires loopback sockets and browser subprocesses. In a sandbox that blocks them, `make check`, `make test`, and test discovery remain available, but discovery alone does not verify browser behavior.
