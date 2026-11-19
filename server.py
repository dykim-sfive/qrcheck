#!/usr/bin/env python3
"""파일/클립보드 <-> 애니메이션 QR 웹앱.

실행:  python3 server.py [포트]     ->  http://127.0.0.1:8765
QR 기능에는 `pip install -r requirements.txt` (segno, zxing-cpp, opencv-python-headless, numpy) 가 필요하다.
클립보드 압축(pack.py)은 표준 라이브러리만 쓴다.
"""
import base64
import json
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pack

try:
    import qr_codec
    import segno  # noqa: F401
    import zxingcpp  # noqa: F401
    QR_OK = True
except ImportError:
    qr_codec = None
    QR_OK = False

ROOT = Path(__file__).resolve().parent
MAX_BODY = 30 * 1024 * 1024               # 일반 요청(JSON, 인코딩할 파일)
QR_MAX_UPLOAD = 1024 * 1024 * 1024        # 촬영한 영상 업로드
QR_NEED = "QR 기능에는 `pip install -r requirements.txt` (segno, zxing-cpp, opencv-python-headless, numpy) 가 필요합니다."

_qr_sessions: dict = {}
_qr_lock = threading.Lock()


def qr_session(sid: str, reset: bool = False):
    """세션별 Decoder. 여러 영상/사진의 결과를 이어서 병합하기 위해 서버에 보관한다 (1시간 미사용 시 폐기)."""
    with _qr_lock:
        now = time.time()
        for k in [k for k, (t, _) in _qr_sessions.items() if now - t > 3600]:
            del _qr_sessions[k]
        if reset or sid not in _qr_sessions:
            if len(_qr_sessions) >= 50:
                raise ValueError("세션이 너무 많습니다")
            _qr_sessions[sid] = (now, qr_codec.Decoder())
        dec = _qr_sessions[sid][1]
        _qr_sessions[sid] = (now, dec)
        return dec


def qr_progress(dec, extra=None) -> dict:
    out = dict(k=dec.k, rank=dec.rank, done=dec.done, seen=len(dec.seen), stats=dec.stats, size=dec.size)
    if dec.done:
        data = dec.result()
        out["ok"] = data is not None
        if data is not None:
            out["data_b64"] = base64.b64encode(data).decode()
    return dict(out, **(extra or {}))


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("요청이 너무 큽니다.")
        return self.rfile.read(n)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            body = (ROOT / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/grid.html" or (path.startswith("/grid/") and path.endswith(".js")):
            f = (ROOT / path.lstrip("/")).resolve()
            if f.parent not in (ROOT, ROOT / "grid") or not f.is_file():
                self._json(dict(error="not found"), 404)
                return
            body = f.read_bytes()
            ctype = "text/html; charset=utf-8" if f.suffix == ".html" else "text/javascript; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/status":
            self._json(dict(qr=QR_OK))
        else:
            self._json(dict(error="not found"), 404)

    def do_POST(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/pack":
                req = json.loads(self._body() or b"{}")
                items = [(it.get("name", ""), base64.b64decode(it.get("b64", ""), validate=True))
                         for it in req.get("items", [])]
                zipped, names = pack.pack_items(items)
                self._json(dict(zip_b64=base64.b64encode(zipped).decode(), files=names,
                                original=sum(len(d) for _, d in items), packed=len(zipped)))
            elif u.path == "/api/qr/encode":
                if not QR_OK:
                    raise RuntimeError(QR_NEED)
                ver, ecc, rep = int(q.get("version", 15)), q.get("ecc", "M"), float(q.get("repair", 0.5))
                if ver not in (10, 15, 20, 25) or ecc not in ("L", "M", "Q") or not 0 <= rep <= 3:
                    raise ValueError("지원하지 않는 QR 설정입니다.")
                data = self._body()
                st = qr_codec.make_stream(data, ver, ecc, rep)
                self._json(dict(frames=st.frames, modules=st.modules, k=st.k, n_frames=st.n_frames,
                                block_size=st.block_size, size=len(data), version=ver, ecc=ecc))
            elif u.path == "/api/qr/reset":
                if not QR_OK:
                    raise RuntimeError(QR_NEED)
                qr_session(q.get("session", ""), reset=True)
                self._json(dict(ok=True))
            elif u.path == "/api/qr/decode":
                if not QR_OK:
                    raise RuntimeError(QR_NEED)
                dec = qr_session(q.get("session", "") or uuid.uuid4().hex)
                name, step = q.get("name", "upload"), max(1, int(q.get("step", 1)))
                n = int(self.headers.get("Content-Length") or 0)
                if n > QR_MAX_UPLOAD:
                    raise ValueError("파일이 너무 큽니다 (최대 1GB)")
                before = dec.rank
                with tempfile.TemporaryDirectory() as d:
                    path = Path(d) / ("in" + (Path(name).suffix.lower() or ".bin"))
                    with open(path, "wb") as f:
                        left = n
                        while left:
                            chunk = self.rfile.read(min(1 << 20, left))
                            if not chunk:
                                break
                            f.write(chunk)
                            left -= len(chunk)
                    t0 = time.time()
                    qr_codec.scan_file(str(path), dec, step=step)      # 영상/사진 모두, 멈춤 보호 포함
                self._json(qr_progress(dec, dict(gained=dec.rank - before, seconds=round(time.time() - t0, 1), file=name)))
            else:
                self._json(dict(error="not found"), 404)
        except (ValueError, KeyError) as e:
            self._json(dict(error=str(e)), 400)
        except Exception as e:
            self._json(dict(error=str(e)), 500)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"http://127.0.0.1:{port}  (QR 기능: {'사용 가능' if QR_OK else '의존성 없음 → pip install -r requirements.txt'})")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
