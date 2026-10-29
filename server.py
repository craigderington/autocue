#!/usr/bin/env python3
"""Local teleprompter, using only Python's standard library and Poppler."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib
import xml.etree.ElementTree as ET
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD = 10 * 1024 * 1024
MAX_TEXT = 200_000
FALLBACK = {
    "name": "Tokyo Night", "connected": False, "mode": "dark",
    "background": "#1a1b26", "foreground": "#c0caf5", "accent": "#7aa2f7",
}


class ImportErrorMessage(ValueError):
    """An import error safe to display in the interface."""


def theme_candidates():
    if override := os.environ.get("OMARCHY_THEME_DIR"):
        return [Path(override).expanduser()]
    home = Path.home()
    state = Path(os.environ.get("XDG_STATE_HOME", home / ".local/state"))
    config = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    return [state / "omarchy/current/theme", config / "omarchy/current/theme"]


def read_theme():
    for directory in theme_candidates():
        try:
            if (directory / "colors.toml").is_file():
                colors = tomllib.loads((directory / "colors.toml").read_text())
            else:
                terminal = tomllib.loads((directory / "alacritty.toml").read_text()).get("colors", {})
                colors = {**terminal.get("primary", {}), "accent": terminal.get("normal", {}).get("blue", "")}
            background = colors.get("background", colors.get("bg", ""))
            if not isinstance(background, str) or not re.fullmatch(r"#[\da-fA-F]{6}", background):
                continue
            palette = dict(FALLBACK)
            for key, aliases in {"background": ["background", "bg"],
                                 "foreground": ["foreground", "fg"],
                                 "accent": ["accent", "color4", "blue"]}.items():
                for alias in aliases:
                    value = colors.get(alias, "")
                    if isinstance(value, str) and re.fullmatch(r"#[\da-fA-F]{6}", value):
                        palette[key] = value
                        break
            name_path = directory.parent / "theme.name"
            name = name_path.read_text().strip() if name_path.is_file() else directory.resolve().name
            if name == "theme":
                name = "Omarchy"
            brightness = sum(int(background[i:i + 2], 16) * weight for i, weight in [(1, 0.299), (3, 0.587), (5, 0.114)])
            inferred_mode = "light" if brightness > 155 or (directory / "light.mode").exists() else "dark"
            palette.update(name=name.replace("-", " ").title(), connected=True,
                           mode=colors.get("mode", inferred_mode))
            return palette
        except (OSError, ValueError, AttributeError, TypeError):
            continue
    return dict(FALLBACK)


def markdown_text(text):
    text = re.sub(r"^[ \t]*```[^\n]*$|^[ \t]*~~~[^\n]*$", "", text, flags=re.M)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d+[.)][ \t]+)", "", text, flags=re.M)
    text = re.sub(r"^[ \t]*(?:[-*_][ \t]*){3,}$", "", text, flags=re.M)
    text = re.sub(r"(\*\*|__|~~|`)(.*?)\1", r"\2", text)
    text = re.sub(r"(?<!\w)[*_]([^\n*_]+)[*_](?!\w)", r"\1", text)
    return text


def extract_script(data, filename):
    extension = Path(filename).suffix.lower()
    if extension in {".txt", ".md", ".markdown"}:
        try:
            encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
            text = data.decode(encoding)
        except UnicodeError as error:
            raise ImportErrorMessage("Save your text file as UTF-8 or UTF-16 and try again.") from error
        if "\0" in text:
            raise ImportErrorMessage("This file does not appear to contain plain text.")
        if extension != ".txt":
            text = markdown_text(text)
    elif extension == ".docx":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                info = archive.getinfo("word/document.xml")
                if info.file_size > 20 * 1024 * 1024:
                    raise ImportErrorMessage("This Word document is too large to read.")
                document = ET.fromstring(archive.read(info))
            namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
            paragraphs = []
            for paragraph in document.iter(namespace + "p"):
                parts = []
                for element in paragraph.iter():
                    if element.tag == namespace + "t":
                        parts.append(element.text or "")
                    elif element.tag in {namespace + "br", namespace + "cr"}:
                        parts.append("\n")
                    elif element.tag == namespace + "tab":
                        parts.append(" ")
                paragraphs.append("".join(parts))
            text = "\n\n".join(paragraphs)
        except (zipfile.BadZipFile, KeyError, ET.ParseError, RuntimeError) as error:
            raise ImportErrorMessage("This Word document could not be read. Try saving a fresh .docx copy.") from error
    elif extension == ".pdf":
        if not data.startswith(b"%PDF-"):
            raise ImportErrorMessage("This file does not appear to be a PDF.")
        if not shutil.which("pdftotext"):
            raise ImportErrorMessage("PDF import needs Poppler. Install it with: sudo pacman -S poppler")
        try:
            with tempfile.TemporaryDirectory(prefix="omarchy-prompter-") as temp:
                source = Path(temp) / "script.pdf"
                output = Path(temp) / "script.txt"
                source.write_bytes(data)
                result = subprocess.run(["pdftotext", "-enc", "UTF-8", "-nopgbrk", str(source), str(output)],
                                        capture_output=True, timeout=15, check=False)
                if result.returncode:
                    raise ImportErrorMessage("This PDF could not be read. Check that it is not password protected.")
                if output.stat().st_size > MAX_TEXT * 4:
                    raise ImportErrorMessage("This PDF is too long. Import a shorter script.")
                text = output.read_text(encoding="utf-8")
        except subprocess.TimeoutExpired as error:
            raise ImportErrorMessage("This PDF took too long to read. Try a smaller file.") from error
        text = re.sub(r"(?<=\w)-\n(?=\w)", "", text)
        text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
        if not text.strip():
            raise ImportErrorMessage("No selectable text found. Scanned PDFs need OCR first; try a text-based PDF or .docx.")
    elif extension == ".doc":
        raise ImportErrorMessage("Please save this older Word file as .docx, then import it again.")
    else:
        raise ImportErrorMessage("Choose a .docx, .pdf, .txt, or .md file.")
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00ad", "").strip()
    if not text:
        raise ImportErrorMessage("This file has no readable text. Choose another script.")
    if len(text) > MAX_TEXT:
        raise ImportErrorMessage("This script is too long. Keep scripts under 200,000 characters.")
    return text


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, data, content_type="application/json; charset=utf-8"):
        body = json.dumps(data).encode() if isinstance(data, dict) else data
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        # Reject foreign hosts/origins; the service only listens on loopback.
        host = self.headers.get("Host", "")
        if host not in {f"localhost:{self.server.server_port}", f"127.0.0.1:{self.server.server_port}"}:
            self.reply(403, {"error": "Use the localhost address printed by the server."})
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://localhost:{self.server.server_port}", f"http://127.0.0.1:{self.server.server_port}"}:
            self.reply(403, {"error": "Imports are only accepted from this local app."})
            return False
        return True

    def do_GET(self):
        if not self.allowed():
            return
        path = urlsplit(self.path).path
        if path == "/api/theme":
            return self.reply(200, read_theme())
        assets = {"/": ("index.html", "text/html; charset=utf-8"),
                  "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                  "/playback.js": ("playback.js", "text/javascript; charset=utf-8"),
                  "/styles.css": ("styles.css", "text/css; charset=utf-8"),
                  "/favicon.svg": ("favicon.svg", "image/svg+xml")}
        if path not in assets:
            return self.reply(404, {"error": "Not found"})
        filename, content_type = assets[path]
        self.reply(200, (ROOT / "public" / filename).read_bytes(), content_type)

    def do_POST(self):
        if not self.allowed():
            return
        url = urlsplit(self.path)
        if url.path != "/api/import":
            return self.reply(404, {"error": "Not found"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > MAX_UPLOAD:
                return self.reply(413, {"error": "Choose a nonempty file smaller than 10 MB."})
            filename = parse_qs(url.query).get("filename", ["script.txt"])[0]
            text = extract_script(self.rfile.read(size), filename)
            self.reply(200, {"text": text, "name": Path(filename).name})
        except (ImportErrorMessage, ValueError) as error:
            self.reply(422, {"error": str(error)})
        except Exception:
            self.reply(500, {"error": "The file could not be imported. Try a fresh copy or a text file."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=3400)
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        parser.error(f"Cannot start the local server: {error}. Check the port and local network permissions.")
    print(f"Omarchy Teleprompter · http://localhost:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
