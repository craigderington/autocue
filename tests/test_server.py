import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer
import zipfile

import server


def docx(paragraphs):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs + '</w:body></w:document>')
    return buffer.getvalue()


def pdf():
    # Minimal valid PDF fixture, with computed offsets and no generator dependency.
    stream = b"BT /F1 18 Tf 72 720 Td (Hello from the PDF script.) Tj ET"
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

    def test_invalid_and_empty_inputs(self):
        for filename, data in [("empty.txt", b" \n "), ("bad.docx", b"not a zip"), ("bad.pdf", b"not a PDF"), ("old.doc", b"legacy"), ("script.exe", b"program"), ("binary.txt", b"a\0b"), ("bad.txt", b"\xff\xff")]:
            with self.subTest(filename=filename), self.assertRaises(server.ImportErrorMessage):
                server.extract_script(data, filename)

    def test_character_limit(self):
        with self.assertRaisesRegex(server.ImportErrorMessage, "too long"):
            server.extract_script(b"a" * (server.MAX_TEXT + 1), "long.txt")


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


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def test_page_and_assets(self):
        for path in ["/", "/app.js", "/styles.css", "/favicon.svg", "/api/theme"]:
            with self.subTest(path=path), urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)
                self.assertIn("nosniff", response.headers["X-Content-Type-Options"])
        with self.assertRaises(HTTPError) as result:
            urlopen(self.base + "/../server.py")
        self.assertEqual(result.exception.code, 404)

    def test_import_http(self):
        request = Request(self.base + "/api/import?filename=opening.md", data=b"# Hello\n\nRead this.", method="POST")
        with urlopen(request) as response:
            self.assertEqual(json.load(response)["text"], "Hello\n\nRead this.")

    def test_bad_import_http(self):
        request = Request(self.base + "/api/import?filename=bad.docx", data=b"bad", method="POST")
        with self.assertRaises(HTTPError) as result:
            urlopen(request)
        self.assertEqual(result.exception.code, 422)

    def test_foreign_origin_and_host_rejected(self):
        for headers in [{"Origin": "https://foreign.example"}, {"Host": "foreign.example"}]:
            with self.subTest(headers=headers), self.assertRaises(HTTPError) as result:
                urlopen(Request(self.base + "/api/theme", headers=headers))
            self.assertEqual(result.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
