import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tests"))
import gridfmt as G  # noqa: E402
import server  # noqa: E402
from test_grid_decode import make_photo, rand_bytes  # noqa: E402


class GridApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        lay = G.make_layout(100, 40, 2)
        stream = G.build_stream("api.bin", rand_bytes(2500))
        cls.data = G.parse_stream(stream)[1]
        cls.pages = [cv2.imencode(".png", make_photo(G.render_page(lay, stream, o), 2, bg=30))[1].tobytes()
                     for o in range(0, len(stream), lay.page_bytes)]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def post(self, path, body=b""):
        req = urllib.request.Request(self.base + path, data=body, method="POST")
        return json.loads(urllib.request.urlopen(req).read())

    def test_upload_in_any_order_then_download(self):
        sid = "t-order"
        with self.assertRaises(urllib.error.HTTPError) as cm:                 # 아직 완료 전
            urllib.request.urlopen(f"{self.base}/api/grid/file?session={sid}")
        self.assertEqual(cm.exception.code, 404)
        for i in (2, 0):
            r = self.post(f"/api/grid/photo?session={sid}&name=p{i}.png", self.pages[i])
            self.assertEqual(r["photo"]["status"], "ok")
        self.assertFalse(r["report"]["done"])
        self.assertEqual(r["report"]["missing"], [[1020, 2040]])
        r = self.post(f"/api/grid/photo?session={sid}&name=p1.png", self.pages[1])
        self.assertTrue(r["report"]["done"])
        resp = urllib.request.urlopen(f"{self.base}/api/grid/file?session={sid}")
        self.assertEqual(resp.read(), self.data)
        self.assertIn("api.bin", resp.headers["Content-Disposition"])

    def test_reset_and_bad_photo(self):
        sid = "t-reset"
        self.assertEqual(self.post(f"/api/grid/photo?session={sid}&name=x", b"junk")["photo"]["status"], "unreadable")
        self.post(f"/api/grid/photo?session={sid}&name=a", self.pages[0])
        self.assertEqual(self.post(f"/api/grid/reset?session={sid}")["report"]["covered"], 0)

    def test_page_is_served(self):
        self.assertEqual(urllib.request.urlopen(self.base + "/grid_decode.html").status, 200)


if __name__ == "__main__":
    unittest.main()
