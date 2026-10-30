# Changelog

## 0.1.0 — 2026-10-30

First public release of autocue, a local teleprompter for Omarchy.

- Import Word `.docx`, text-based PDF, text, and Markdown scripts, or edit them directly.
- Read at 40–300 WPM with adjustable text size, seeking, keyboard shortcuts, fullscreen, and mirrored text.
- Follow the active Omarchy theme automatically, with a built-in fallback palette.
- Record camera video and microphone audio independently of scrolling; preview, review, and download takes locally.
- Keep scripts and recordings on the user's device; no accounts, analytics, or runtime package installation.
- Include automated unit, HTTP, and browser checks, plus an isolated Docker browser-test environment.
- Improve secondary-label contrast and expose the keyboard-focusable reading area as a named region.

### Known limits

- PDF import needs Poppler; scanned PDFs need OCR first. Older `.doc` files must be saved as `.docx`.
- Recordings stay in browser memory until downloaded and stop at 15 minutes or 256 MiB.
- Camera recording has been verified using synthetic devices in Chromium and Firefox. Native Safari/iOS recording and physical camera/microphone quality still need device verification; the Linux WebKit test build lacks `MediaRecorder`.
- The server is for local desktop use and listens on loopback. The Dockerfile runs browser tests; there is no application Compose stack.
