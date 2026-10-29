"""Start an isolated app for browser tests; never read the user's theme."""
import os
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server
from test_server import docx, pdf

STATE = ROOT / ".browser-test-state"
STATE.mkdir(exist_ok=True)
THEME = STATE / "theme"
THEME.mkdir(exist_ok=True)
(THEME / "colors.toml").write_text('background = "#1a1b26"\nforeground = "#c0caf5"\naccent = "#7aa2f7"\nmode = "dark"\n')
(STATE / "theme.name").write_text("test-night")
(STATE / "sample.docx").write_bytes(docx('<w:p><w:r><w:t>Words from a Word document.</w:t></w:r></w:p>'))
(STATE / "sample.pdf").write_bytes(pdf())
(STATE / "scan.pdf").write_bytes(pdf(""))
os.environ["OMARCHY_THEME_DIR"] = str(THEME)


class QuietHandler(server.Handler):
    def log_message(self, *args):
        pass


if __name__ == "__main__":
    try:
        with ThreadingHTTPServer(("127.0.0.1", 3417), QuietHandler) as http:
            print("Browser test server · http://127.0.0.1:3417", flush=True)
            http.serve_forever()
    except OSError as error:
        sys.exit(f"Cannot start the browser test server: {error}. Loopback sockets must be permitted.")
