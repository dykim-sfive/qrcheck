"""클립보드 항목 등 여러 파일을 ZIP(deflate 최대 압축) 하나로 묶는다. 표준 라이브러리만 사용."""
from __future__ import annotations

import io
import re
import zipfile


def _safe_name(name: str, used: set[str]) -> str:
    name = re.sub(r"[\x00-\x1f\\/:*?\"<>|]", "_", (name or "").strip()).lstrip(".") or "item"
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    cand, i = name, 2
    while cand in used:
        cand = f"{stem}_{i}" + (f".{ext}" if ext else "")
        i += 1
    used.add(cand)
    return cand


def pack_items(items: list[tuple[str, bytes]]) -> tuple[bytes, list[str]]:
    """(이름, 바이트) 목록 -> (ZIP 바이트, 실제로 쓰인 파일명 목록). 경로 문자는 치환, 중복 이름은 _2 를 붙인다."""
    if not items:
        raise ValueError("압축할 항목이 없습니다.")
    buf, used, names = io.BytesIO(), set(), []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, data in items:
            n = _safe_name(name, used)
            z.writestr(n, data)
            names.append(n)
    return buf.getvalue(), names
