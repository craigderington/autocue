import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

import server


def docx(paragraphs):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '</w:body></w:document>')
    return buffer.getvalue()


def pdf(message="Hello from the PDF script."):
    # Minimal valid PDF fixture, with computed offsets and no generator dependency.
    stream = f"BT /F1 18 Tf 72 720 Td ({message}) Tj ET".encode()
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
    data = b"%PDF-1.4\n"
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    start = len(data)
    data += b"xref\n0 6\n0000000000 65535 f \n"
    data += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    return data + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()


class ExtractionTests(unittest.TestCase):
    def test_text_encodings(self):
        for encoding in ["utf-8-sig", "utf-16"]:
            self.assertEqual(server.extract_script("A clear café.\r\nNext line.".encode(encoding), "script.txt"), "A clear café.\nNext line.")

    def test_markdown(self):
        content = b"# Opening\n\n**Hello** [world](https://example.com).\n\n- Speak *clearly*."
        self.assertEqual(server.extract_script(content, "script.md"), "Opening\n\nHello world.\n\nSpeak clearly.")

    def test_docx_runs_breaks_tables(self):
        data = docx('<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world.</w:t><w:br/><w:t>Take two.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table text.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
        self.assertEqual(server.extract_script(data, "script.docx"), "Hello world.\nTake two.\n\nTable text.")

    @unittest.skipUnless(server.shutil.which("pdftotext"), "Poppler is not installed")
    def test_pdf(self):
        self.assertEqual(server.extract_script(pdf(), "script.pdf"), "Hello from the PDF script.")

    def test_missing_pdf_dependency(self):
        with patch("server.shutil.which", return_value=None):
            with self.assertRaisesRegex(server.ImportErrorMessage, "Poppler"):
                server.extract_script(pdf(), "script.pdf")

    @unittest.skipUnless(server.shutil.which("pdftotext"), "Poppler is not installed")
    def test_pdf_without_text_explains_ocr(self):
        with self.assertRaisesRegex(server.ImportErrorMessage, "OCR"):
            server.extract_script(pdf(""), "scan.pdf")

    def test_invalid_and_empty_inputs(self):
        for filename, data in [("empty.txt", b" \n "), ("bad.docx", b"not a zip"), ("bad.pdf", b"not a PDF"), ("old.doc", b"legacy"), ("script.exe", b"program"), ("binary.txt", b"a\0b"), ("bad.txt", b"\xff\xff")]:
            with self.subTest(filename=filename), self.assertRaises(server.ImportErrorMessage):
                server.extract_script(data, filename)

    def test_character_limit(self):
        with self.assertRaisesRegex(server.ImportErrorMessage, "too long"):
            server.extract_script(b"a" * (server.MAX_TEXT + 1), "long.txt")

    def test_pdf_timeout_removes_temporary_script(self):
        locations = []

        def timeout(command, **kwargs):
            source = Path(command[-2])
            self.assertTrue(source.exists())
            locations.append(source.parent)
            raise subprocess.TimeoutExpired(command, 15)

        with patch("server.shutil.which", return_value="pdftotext"), patch("server.subprocess.run", side_effect=timeout):
            with self.assertRaisesRegex(server.ImportErrorMessage, "too long"):
                server.extract_script(pdf(), "slow.pdf")
        self.assertTrue(locations)
        self.assertFalse(locations[0].exists())

    def test_pdf_conversion_error_removes_temporary_script(self):
        locations = []

        def fail(command, **kwargs):
            locations.append(Path(command[-2]).parent)
            return SimpleNamespace(returncode=1)

        with patch("server.shutil.which", return_value="pdftotext"), patch("server.subprocess.run", side_effect=fail):
            with self.assertRaisesRegex(server.ImportErrorMessage, "password protected"):
                server.extract_script(pdf(), "protected.pdf")
        self.assertFalse(locations[0].exists())

    def test_pdf_unwraps_lines_and_keeps_paragraphs(self):
        def convert(command, **kwargs):
            Path(command[-1]).write_text("A presenta-\ntion script.\n\nThe next\nparagraph.\n")
            return SimpleNamespace(returncode=0)

        with patch("server.shutil.which", return_value="pdftotext"), patch("server.subprocess.run", side_effect=convert):
            self.assertEqual(server.extract_script(pdf(), "script.pdf"), "A presentation script.\n\nThe next paragraph.")


class ThemeTests(unittest.TestCase):
    def test_fallback(self):
        with patch("server.theme_candidates", return_value=[]):
            self.assertFalse(server.read_theme()["connected"])

    def test_theme_switch_and_aliases(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            theme = root / "theme"
            theme.mkdir()
            (root / "theme.name").write_text("rose-pine")
            with patch("server.theme_candidates", return_value=[theme]):
                (theme / "colors.toml").write_text('background = "#191724"\nforeground = "#e0def4"\naccent = "#c4a7e7"')
                first = server.read_theme()
                self.assertEqual(first["name"], "Rose Pine")
                self.assertEqual(first["accent"], "#c4a7e7")
                self.assertTrue(first["connected"])
                (theme / "colors.toml").write_text('bg = "#ffffff"\nfg = "#222222"\ncolor4 = "#0000ff"\nmode = "light"')
                second = server.read_theme()
                self.assertEqual(second["background"], "#ffffff")
                self.assertEqual(second["mode"], "light")
                self.assertEqual(second["accent"], "#0000ff")
                (theme / "colors.toml").write_text("unfinished = ")
                self.assertFalse(server.read_theme()["connected"])

    def test_legacy_terminal_palette_and_light_mode(self):
        with tempfile.TemporaryDirectory() as temporary:
            theme = Path(temporary)
            (theme / "alacritty.toml").write_text('[colors.primary]\nbackground = "#fafafa"\nforeground = "#222222"\n[colors.normal]\nblue = "#0055aa"')
            with patch("server.theme_candidates", return_value=[theme]):
                result = server.read_theme()
                self.assertTrue(result["connected"])
                self.assertEqual(result["accent"], "#0055aa")
                self.assertEqual(result["mode"], "light")

    def test_xdg_paths_and_explicit_override(self):
        with patch.dict(os.environ, {"XDG_STATE_HOME": "/tmp/test-state", "XDG_CONFIG_HOME": "/tmp/test-config"}, clear=True):
            self.assertEqual(server.theme_candidates(), [Path("/tmp/test-state/omarchy/current/theme"), Path("/tmp/test-config/omarchy/current/theme")])
        with patch.dict(os.environ, {"OMARCHY_THEME_DIR": "/tmp/custom-theme"}):
            self.assertEqual(server.theme_candidates(), [Path("/tmp/custom-theme")])

    def test_replacing_theme_symlink_is_detected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, color in [("night", "#111111"), ("day", "#ffffff")]:
                directory = root / name
                directory.mkdir()
                (directory / "colors.toml").write_text(f'background = "{color}"\n')
            current = root / "theme"
            current.symlink_to(root / "night", target_is_directory=True)
            with patch("server.theme_candidates", return_value=[current]):
                self.assertEqual(server.read_theme()["background"], "#111111")
                replacement = root / "next-theme"
                replacement.symlink_to(root / "day", target_is_directory=True)
                replacement.replace(current)
                self.assertEqual(server.read_theme()["background"], "#ffffff")

    def test_invalid_background_uses_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "colors.toml").write_text('background = "url(https://example.com)"')
            with patch("server.theme_candidates", return_value=[directory]):
                self.assertFalse(server.read_theme()["connected"])


class MemoryConnection:
    """Exercise the real HTTP parser and responses without opening a socket."""
    def __init__(self, data):
        self.input = io.BytesIO(data)
        self.output = io.BytesIO()

    def makefile(self, mode, *args):
        return self.input if "r" in mode else self.output

    def sendall(self, data):
        self.output.write(data)


class HTTPTests(unittest.TestCase):
    def request(self, path, body=None, headers=None):
        payload = body or b""
        fields = {"Host": "127.0.0.1:3400", **(headers or {})}
        if body is not None:
            fields["Content-Length"] = str(len(body))
        lines = [f"{'POST' if body is not None else 'GET'} {path} HTTP/1.1"]
        lines.extend(f"{key}: {value}" for key, value in fields.items())
        connection = MemoryConnection(("\r\n".join(lines) + "\r\n\r\n").encode() + payload)
        server.Handler(connection, ("127.0.0.1", 12345), SimpleNamespace(server_port=3400))
        head, result = connection.output.getvalue().split(b"\r\n\r\n", 1)
        return int(head.split(b" ")[1]), head, result

    def test_page_and_assets(self):
        for path in ["/", "/app.js", "/playback.js", "/styles.css", "/favicon.svg", "/api/theme"]:
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertIn(b"nosniff", headers)
                self.assertTrue(body)
        self.assertEqual(self.request("/../server.py")[0], 404)

    def test_import_http(self):
        status, _, body = self.request("/api/import?filename=opening.md", b"# Hello\n\nRead this.")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["text"], "Hello\n\nRead this.")

    def test_unicode_filename_and_text(self):
        status, _, body = self.request("/api/import?filename=caf%C3%A9.txt", "A café opening.".encode())
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual(result["name"], "café.txt")
        self.assertEqual(result["text"], "A café opening.")

    def test_empty_import(self):
        self.assertEqual(self.request("/api/import?filename=empty.txt", b"")[0], 413)

    def test_bad_import_http(self):
        status, _, body = self.request("/api/import?filename=bad.docx", b"bad")
        self.assertEqual(status, 422)
        self.assertIn("Word document", json.loads(body)["error"])

    def test_foreign_origin_and_host_rejected(self):
        for headers in [{"Origin": "https://foreign.example"}, {"Host": "foreign.example"}]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request("/api/theme", headers=headers)[0], 403)

    def test_oversized_import_is_rejected_before_reading_body(self):
        connection = MemoryConnection(f"POST /api/import?filename=large.txt HTTP/1.1\r\nHost: localhost:3400\r\nContent-Length: {server.MAX_UPLOAD + 1}\r\n\r\n".encode())
        server.Handler(connection, ("127.0.0.1", 12345), SimpleNamespace(server_port=3400))
        self.assertIn(b"413", connection.output.getvalue().split(b"\r\n", 1)[0])


if __name__ == "__main__":
    unittest.main()
