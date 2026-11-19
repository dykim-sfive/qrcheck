import random
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import gridfmt as G  # noqa: E402


def rand_bytes(n, seed=1):
    r = random.Random(seed)
    return bytes(r.randrange(256) for _ in range(n))


class GridFmtTest(unittest.TestCase):
    def test_roundtrip_each_level(self):
        for levels in (2, 4, 8):
            layout = G.make_layout(120, 40, levels)
            stream = G.build_stream("a.bin", rand_bytes(5000))
            cells = G.render_page(layout, stream, 0)
            self.assertEqual(cells.shape, (40, 120, 3))
            self.assertLessEqual(int(cells.max()), levels - 1)
            res = G.decode_cells(cells, levels)
            self.assertTrue(res.ok, levels)
            self.assertEqual(res.header.plen, layout.page_bytes)
            self.assertEqual(res.payload, stream[:layout.page_bytes])
            self.assertEqual(res.rs_corrected, 0)
            self.assertEqual(res.cell_error_rate, 0.0)

    def test_corrects_corrupted_cells(self):
        layout = G.make_layout(120, 40, 2)
        stream = G.build_stream("a.bin", rand_bytes(5000))
        cells = G.render_page(layout, stream, 0).copy()
        rr, cc = np.nonzero(~G.reserved_mask(layout))
        rnd = random.Random(7)
        for i in rnd.sample(range(len(rr)), int(len(rr) * 0.02)):
            cells[rr[i], cc[i]] = [rnd.randrange(2) for _ in range(3)]
        res = G.decode_cells(cells, 2)
        self.assertTrue(res.ok)
        self.assertGreater(res.rs_corrected, 0)
        self.assertEqual(res.payload, stream[:layout.page_bytes])

    def test_last_page_padding(self):
        layout = G.make_layout(120, 40, 2)
        stream = G.build_stream("a.bin", rand_bytes(3000))
        offset = (len(stream) // layout.page_bytes) * layout.page_bytes
        res = G.decode_cells(G.render_page(layout, stream, offset), 2)
        self.assertTrue(res.ok)
        self.assertLess(res.header.plen, layout.page_bytes)
        self.assertEqual(res.header.plen, len(stream) - offset)
        self.assertEqual(res.payload, stream[offset:])

    def test_header_crc(self):
        h = G.Header(log2l=1, cols=120, rows=40, nsym=51, file_id=7, offset=0, total=10, plen=10)
        raw = G.encode_header(h)
        self.assertEqual(len(raw), 27)
        self.assertEqual(G.decode_header(raw), h)
        bad = bytearray(raw)
        bad[5] ^= 0x01
        self.assertIsNone(G.decode_header(bytes(bad)))

    def test_empty_file_and_long_name(self):
        stream = G.build_stream("e", b"")
        self.assertEqual(G.parse_stream(stream), ("e", b""))
        layout = G.make_layout(120, 40, 4)
        res = G.decode_cells(G.render_page(layout, stream, 0), 4)
        self.assertTrue(res.ok)
        self.assertEqual(res.payload, stream)
        with self.assertRaises(ValueError):
            G.build_stream("x" * 256, b"")
        self.assertEqual(G.parse_stream(G.build_stream("한글.txt", b"hi")), ("한글.txt", b"hi"))

    def test_reserved(self):
        lay = G.make_layout(100, 40, 2)
        for rc in [(0, 0), (7, 7), (0, 99), (39, 0), (39, 99), (0, 8), (0, 91), (1, 8), (1, 79)]:
            self.assertTrue(G.is_reserved(lay, *rc), rc)
        for rc in [(1, 80), (2, 8), (8, 0), (20, 50), (39, 50)]:
            self.assertFalse(G.is_reserved(lay, *rc), rc)
        self.assertEqual(int((~G.reserved_mask(lay)).sum()), lay.data_cells)
        with self.assertRaises(ValueError):
            G.make_layout(89, 40, 2)
        with self.assertRaises(ValueError):
            G.make_layout(90, 19, 2)

    def test_markers_and_reference_row(self):
        lay = G.make_layout(100, 40, 4)
        cells = G.render_page(lay, G.build_stream("a", b"x"), 0)
        w, b = 3, 0
        for (r0, c0) in [(0, 0), (0, 92), (32, 0), (32, 92)]:
            blk = cells[r0:r0 + 8, c0:c0 + 8]
            self.assertTrue((blk[0, :] == w).all() and (blk[1, 1:7] == b).all())
            self.assertTrue((blk[2, 2:6] == w).all() and (blk[3:5, 3:5] == b).all())
        ref = [tuple(cells[0, c]) for c in range(8, 8 + 14)]
        self.assertEqual(ref[:2], [(0, 0, 0), (3, 3, 3)])
        self.assertEqual(ref[2:6], [(k, 0, 0) for k in range(4)])
        self.assertEqual(ref[6:10], [(0, k, 0) for k in range(4)])
        self.assertEqual(ref[10:14], [(0, 0, k) for k in range(4)])


if __name__ == "__main__":
    unittest.main()
