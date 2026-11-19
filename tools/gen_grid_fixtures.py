"""JS 구현이 따라야 할 기준 데이터를 Python(reedsolo, gridfmt)으로 만든다.
실행: python3 tools/gen_grid_fixtures.py  ->  grid/test/fixtures.json"""
import json
import random
from pathlib import Path

from reedsolo import RSCodec

OUT = Path(__file__).resolve().parent.parent / "grid" / "test" / "fixtures.json"


def rs_cases():
    rnd = random.Random(1234)
    cases = []
    for nsym, n, kind in [(51, 204, "rand"), (51, 100, "rand"), (51, 1, "rand"), (32, 100, "rand"),
                          (32, 223, "zero"), (51, 204, "ff")]:
        data = bytes(rnd.randrange(256) for _ in range(n)) if kind == "rand" else (b"\x00" if kind == "zero" else b"\xff") * n
        cases.append(dict(nsym=nsym, data_hex=data.hex(), code_hex=bytes(RSCodec(nsym).encode(data)).hex()))
    return cases


def main():
    fx = {}
    if OUT.exists():
        fx = json.loads(OUT.read_text())
    fx["rs"] = rs_cases()
    OUT.write_text(json.dumps(fx))
    print("wrote", OUT, list(fx))


if __name__ == "__main__":
    main()
