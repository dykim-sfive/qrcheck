import random
import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import gridfmt as G  # noqa: E402
import grid_decode as D  # noqa: E402


def rand_bytes(n, seed=3):
    r = random.Random(seed)
    return bytes(r.randrange(256) for _ in range(n))


def make_photo(cells, levels, cell_px=6, margin=40, bg=255):
    """단계 인덱스 격자 -> BGR 이미지 (cv2 규약). 사방에 margin 만큼 배경색 여백."""
    lut = np.array([round(v * 255 / (levels - 1)) for v in range(levels)], np.uint8)
    rgb = lut[cells]
    rgb = np.repeat(np.repeat(rgb, cell_px, axis=0), cell_px, axis=1)
    h, w = rgb.shape[:2]
    canvas = np.full((h + 2 * margin, w + 2 * margin, 3), bg, np.uint8)
    canvas[margin:margin + h, margin:margin + w] = rgb
    return np.ascontiguousarray(canvas[:, :, ::-1])


def page(levels, cols=100, rows=40, size=5000, offset=0, seed=3, name="a.bin"):
    lay = G.make_layout(cols, rows, levels)
    stream = G.build_stream(name, rand_bytes(size, seed))
    return lay, stream, G.render_page(lay, stream, offset)


class ReadPhotoTest(unittest.TestCase):
    def test_clean_image(self):
        for levels in (2, 4, 8):
            lay, stream, cells = page(levels)
            res = D.read_photo(make_photo(cells, levels, bg=30))
            self.assertIsNotNone(res, levels)
            self.assertTrue(res.ok, levels)
            self.assertEqual(res.payload, stream[:lay.page_bytes])

    def test_perspective_color_noise(self):
        lay, stream, cells = page(2)
        img = make_photo(cells, 2, cell_px=8, margin=60, bg=40)
        h, w = img.shape[:2]
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst = np.float32([[30, 20], [w - 10, 45], [w + 25, h + 15], [5, h - 20]])
        out = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w + 60, h + 60), borderValue=(40, 40, 40))
        out = out.astype(np.float32) / 255
        out = np.clip(out * np.float32([1.1, 1.0, 0.9]), 0, 1) ** 0.9 * 255   # BGR 틴트 + 감마
        out = cv2.GaussianBlur(out, (0, 0), 1.0)
        out += np.random.default_rng(0).normal(0, 3, out.shape)
        res = D.read_photo(np.clip(out, 0, 255).astype(np.uint8))
        self.assertIsNotNone(res)
        self.assertTrue(res.ok)
        self.assertEqual(res.payload, stream[:lay.page_bytes])

    def test_rotated(self):
        lay, stream, cells = page(2)
        img = make_photo(cells, 2, bg=30)
        for k in (1, 2, 3):
            res = D.read_photo(np.ascontiguousarray(np.rot90(img, k)))
            self.assertIsNotNone(res, k)
            self.assertTrue(res.ok, k)
            self.assertEqual(res.payload, stream[:lay.page_bytes])

    def test_no_markers(self):
        self.assertIsNone(D.read_photo(np.full((300, 400, 3), 255, np.uint8)))
        noise = np.random.default_rng(1).integers(0, 256, (300, 400, 3), dtype=np.uint8)
        self.assertIsNone(D.read_photo(noise))


class AssembleTest(unittest.TestCase):
    def results(self, spec, stream):
        out = []
        for cols, rows, offset in spec:
            lay = G.make_layout(cols, rows, 2)
            out.append(G.decode_cells(G.render_page(lay, stream, offset), 2))
        return out

    def test_mixed_layouts_duplicates_and_other_file(self):
        stream = G.build_stream("mix.bin", rand_bytes(3000))
        spec = [(100, 40, 0), (100, 40, 1020), (100, 40, 2040), (120, 30, 816), (120, 30, 1632), (120, 30, 2448),
                (100, 40, 1020)]                                  # 마지막은 중복
        other = G.build_stream("other.bin", rand_bytes(3000, seed=9))
        res = self.results(spec, stream) + self.results([(100, 40, 0)], other)
        rep = D.assemble(res)
        self.assertEqual(rep.name, "mix.bin")
        self.assertEqual(rep.data, G.parse_stream(stream)[1])
        self.assertEqual(rep.missing_ranges, [])

    def test_missing_pages_reported(self):
        stream = G.build_stream("mix.bin", rand_bytes(3000))
        spec = [(100, 40, 0), (120, 30, 1632), (100, 40, 2040), (120, 30, 2448)]
        rep = D.assemble(self.results(spec, stream))
        self.assertIsNone(rep.data)
        self.assertEqual(rep.missing_ranges, [(1020, 1632)])


if __name__ == "__main__":
    unittest.main()
