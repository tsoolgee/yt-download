"""שרת דמה לבדיקה: מגיש את הפיקסצ'רים כמו googlevideo (פרמטר range בשאילתה)
וקולט את הקובץ המוזג חזרה ב-POST /save כדי ש-ffprobe יבדוק אותו.

python test/serve.py    ->  http://127.0.0.1:8099/test/index.html
"""
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).parent.parent
OUT = Path(__file__).parent / "out"
PORT = 8099

TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".mp4": "video/mp4", ".m4a": "audio/mp4", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/save":
            self.send_error(404)
            return
        name = parse_qs(u.query).get("name", ["out.bin"])[0]
        name = re.sub(r"[^\w.\-]", "_", name)
        OUT.mkdir(exist_ok=True)
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        (OUT / name).write_bytes(data)
        print(f"  saved {name}  {len(data) / 1024:.0f} KB", flush=True)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):
        u = urlparse(self.path)
        path = (ROOT / u.path.lstrip("/")).resolve()
        if not path.is_file() or ROOT not in path.parents and path.parent != ROOT:
            self.send_error(404)
            return
        body = path.read_bytes()

        # יוטיוב מקבל את הטווח בשאילתה (&range=a-b), לא בכותרת Range
        m = re.match(r"(\d+)-(\d+)", parse_qs(u.query).get("range", [""])[0])
        status = 200
        if m:
            a, b = int(m.group(1)), min(int(m.group(2)), len(body) - 1)
            body, status = body[a:b + 1], 206

        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", TYPES.get(path.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"http://127.0.0.1:{PORT}/test/index.html", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
