"""JS 구현이 따라야 할 기준 데이터를 Python(reedsolo, gridfmt)으로 만든다.
실행: python3 tools/gen_grid_fixtures.py  ->  grid/test/fixtures.json"""
import json
import random
from pathlib import Path

from reedsolo import RSCodec

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gridfmt as G  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "grid" / "test" / "fixtures.json"


def rs_cases():
    rnd = random.Random(1234)
    cases = []
    for nsym, n, kind in [(51, 204, "rand"), (51, 100, "rand"), (51, 1, "rand"), (32, 100, "rand"),
                          (32, 223, "zero"), (51, 204, "ff")]:
        data = bytes(rnd.randrange(256) for _ in range(n)) if kind == "rand" else (b"\x00" if kind == "zero" else b"\xff") * n
        cases.append(dict(nsym=nsym, data_hex=data.hex(), code_hex=bytes(RSCodec(nsym).encode(data)).hex()))
    return cases


def page_cases():
    rnd = random.Random(99)
    spec = [(2, 3000, 0), (4, 3000, 0), (8, 3000, 0), (2, 3000, 612), (2, 1000, 612)]   # (levels, 파일 크기, offset)
    out = []
    for levels, size, offset in spec:
        name, data = "샘플.bin", bytes(rnd.randrange(256) for _ in range(size))
        lay = G.make_layout(100, 30, levels, 0.2)
        cells = G.render_page(lay, G.build_stream(name, data), offset)
        out.append(dict(levels=levels, cols=100, rows=30, rs_ratio=0.2, name=name, data_hex=data.hex(),
                        offset=offset, cells_hex=cells.tobytes().hex()))
    return out


def main():
    fx = {}
    if OUT.exists():
        fx = json.loads(OUT.read_text())
    fx["rs"] = rs_cases()
    fx["pages"] = page_cases()
    OUT.write_text(json.dumps(fx))
    print("wrote", OUT, list(fx))


if __name__ == "__main__":
    main()
