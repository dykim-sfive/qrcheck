#!/usr/bin/env python3
"""화면 격자 사진 -> 파일 복원 + 오류율 리포트.

사용:  python3 tools/grid_decode.py 사진1.jpg 사진2.jpg ... -o 출력폴더
장마다 정지 사진 한 장씩(순서·중복 무관, 창 크기가 달라져 칸 수가 다른 사진이 섞여도 됨).
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gridfmt as G  # noqa: E402

LEVELS = (2, 4, 8)


# ---------- 마커 / 기하 ----------
def find_markers(img: np.ndarray):
    """코너 마커(흰-검정-흰-검정 중첩 사각형) 네 개를 찾는다.
    반환: (corners (4,2) float32 TL,TR,BR,BL = 격자 좌표 (1,1),(cols-1,1),(cols-1,rows-1),(1,rows-1) 의 이미지 위치, 칸 픽셀 크기) 또는 None."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    cnts, hier = cv2.findContours(bw, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return None
    hier = hier[0]
    cands = []
    for i, c in enumerate(cnts):
        hole = hier[i][2]
        if hole < 0:
            continue
        core = hier[hole][2]
        if core < 0:
            continue
        area = cv2.contourArea(c)
        if area < 100:
            continue
        r_hole, r_core = cv2.contourArea(cnts[hole]) / area, cv2.contourArea(cnts[core]) / area
        if not (0.3 <= r_hole <= 0.6 and 0.05 <= r_core <= 0.2):      # 이상값 16/36, 4/36
            continue
        approx = cv2.approxPolyDP(c, 0.05 * cv2.arcLength(c, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        cands.append((area, approx.reshape(4, 2).astype(np.float32)))
    cands.sort(key=lambda t: -t[0])
    for i in range(len(cands) - 3):
        win = cands[i:i + 4]
        if win[0][0] / win[3][0] < 1.7:
            break
    else:
        return None
    centers = np.array([q.mean(axis=0) for _, q in win])
    mid = centers.mean(axis=0)
    s, d = centers.sum(axis=1), centers[:, 0] - centers[:, 1]
    order = [int(np.argmin(s)), int(np.argmax(d)), int(np.argmax(s)), int(np.argmin(d))]   # TL,TR,BR,BL
    if len(set(order)) != 4:
        return None
    corners = []
    for k in order:
        quad = win[k][1]
        v = quad[int(np.argmax(np.linalg.norm(quad - mid, axis=1)))]                  # 격자 바깥쪽 모서리
        corners.append(v + (v > mid).astype(np.float32))     # 윤곽은 픽셀 인덱스 좌표: 먼 쪽 모서리는 +1 해야 픽셀 가장자리
    cell_px = float((np.sqrt(np.mean([a for a, _ in win])) + 1) / 6)     # 윤곽 면적은 한 변이 1px 짧게 잡힌다
    return np.array(corners, np.float32), cell_px


def find_corners(img: np.ndarray):
    m = find_markers(img)
    return None if m is None else m[0]


def _points(corners, cols, rows, rc):
    """격자 칸 (r,c) 목록의 중심을 이미지 좌표로."""
    src = np.float32([[1, 1], [cols - 1, 1], [cols - 1, rows - 1], [1, rows - 1]])
    M = cv2.getPerspectiveTransform(src, corners.astype(np.float32))
    pts = np.float32(rc[:, ::-1]) + 0.5
    return cv2.perspectiveTransform(pts.reshape(-1, 1, 2), M).reshape(-1, 2) - 0.5   # 가장자리 좌표 -> 픽셀 인덱스 좌표


def _sample(blur, pts):
    h, w = blur.shape[:2]
    x = np.clip(np.rint(pts[:, 0]).astype(int), 0, w - 1)
    y = np.clip(np.rint(pts[:, 1]).astype(int), 0, h - 1)
    return blur[y, x].astype(np.float64)


def _calibration(obs_ref, cols, levels):
    """기준 행에서 관측 색 -> 이론 색(0..255) 아핀 변환 (4x3)을 최소제곱으로 구한다."""
    true = G.reference_row(cols, levels).astype(np.float64) * 255 / (levels - 1)
    A = np.hstack([obs_ref, np.ones((len(obs_ref), 1))])
    X, *_ = np.linalg.lstsq(A, true, rcond=None)
    return X


def _apply(X, obs, levels):
    A = np.hstack([obs, np.ones((len(obs), 1))])
    return np.clip(np.rint(A @ X / 255 * (levels - 1)), 0, levels - 1).astype(np.uint8)


def sample_cells(img: np.ndarray, corners: np.ndarray, cols: int, rows: int, levels: int,
                 blur: np.ndarray | None = None) -> np.ndarray:
    """사진 -> (rows, cols, 3) 단계 인덱스 (원근 보정 + 기준 행 색 보정)."""
    if blur is None:
        blur = cv2.blur(img[:, :, ::-1], (3, 3))
    rr, cc = np.divmod(np.arange(rows * cols), cols)
    rc = np.stack([rr, cc], axis=1)
    obs = _sample(blur, _points(corners, cols, rows, rc))
    ref = obs[np.arange(CORNER_REF_START, cols - CORNER_REF_START)]          # r=0 행
    X = _calibration(ref, cols, levels)
    return _apply(X, obs, levels).reshape(rows, cols, 3)


CORNER_REF_START = G.CORNER


def _try_header(blur, corners, cols, rows, levels):
    """후보 (cols, rows, levels)로 헤더만 읽어 CRC 가 맞는지 본다."""
    ref_rc = np.stack([np.zeros(cols - 2 * G.CORNER, int), np.arange(G.CORNER, cols - G.CORNER)], axis=1)
    hdr_rc = np.stack([np.ones(G.HEADER_CELLS, int), np.arange(G.HEADER_COL0, G.HEADER_COL0 + G.HEADER_CELLS)], axis=1)
    obs = _sample(blur, _points(corners, cols, rows, np.vstack([ref_rc, hdr_rc])))
    X = _calibration(obs[:len(ref_rc)], cols, levels)
    idx = _apply(X, obs[len(ref_rc):], levels)
    h = G.decode_header(G._cells_to_header_bytes(idx, levels))
    return h if h and (1 << h.log2l) == levels and (h.cols, h.rows) == (cols, rows) else None


def read_photo(img: np.ndarray):
    """사진 한 장 -> PageResult. 마커를 못 찾거나 헤더를 못 읽으면 None, 헤더는 읽었지만 RS 복구 실패면 ok=False."""
    m = find_markers(img)
    if m is None:
        return None
    base, cell_px = m
    k = 2 * int(cell_px * 0.3) + 1          # 칸의 약 60% 폭, 항상 홀수(짝수 커널은 반 픽셀 밀린다)
    blur = cv2.blur(img[:, :, ::-1], (k, k))
    attempts = []
    for rot in range(4):
        corners = np.roll(base, -rot, axis=0)
        est_c = np.linalg.norm(corners[1] - corners[0]) / cell_px + 2
        est_r = np.linalg.norm(corners[3] - corners[0]) / cell_px + 2
        sc, sr = max(3, int(0.05 * est_c)), max(3, int(0.05 * est_r))
        for c in range(int(est_c) - sc, int(est_c) + sc + 2):
            for r in range(int(est_r) - sr, int(est_r) + sr + 2):
                if c >= G.MIN_COLS and r >= G.MIN_ROWS:
                    attempts.append(((c - est_c) ** 2 + (r - est_r) ** 2, rot, c, r))
    attempts.sort()
    for _, rot, c, r in attempts:
        corners = np.roll(base, -rot, axis=0)
        for levels in LEVELS:
            if _try_header(blur, corners, c, r, levels):
                cells = sample_cells(img, corners, c, r, levels, blur)
                return G.decode_cells(cells, levels)
    return None


# ---------- 조립 ----------
@dataclass
class Report:
    name: str | None
    data: bytes | None
    missing_ranges: list = field(default_factory=list)
    per_page: list = field(default_factory=list)
    skipped: int = 0
    crc_mismatch: bool = False        # 모든 구간이 채워졌지만 복원본의 CRC32 가 file_id 와 다름
    total: int = 0                    # 스트림 전체 바이트 (읽힌 장이 없으면 0)
    covered: int = 0                  # 지금까지 채워진 바이트


def assemble(results) -> Report:
    pages = [dict(ok=r.ok, offset=r.header.offset if r.header else None, plen=r.header.plen if r.header else None,
                  cols=r.header.cols if r.header else None, rows=r.header.rows if r.header else None,
                  levels=(1 << r.header.log2l) if r.header else None, rs_corrected=r.rs_corrected,
                  cell_error_rate=r.cell_error_rate, file_id=r.header.file_id if r.header else None)
             for r in results if r is not None]
    good = [r for r in results if r is not None and r.ok]
    if not good:
        return Report(None, None, [], pages)
    fid = Counter(r.header.file_id for r in good).most_common(1)[0][0]
    mine = [r for r in good if r.header.file_id == fid]
    total = Counter(r.header.total for r in mine).most_common(1)[0][0]
    buf, have = bytearray(total), np.zeros(total, bool)
    for r in mine:
        o, p = r.header.offset, r.payload
        n = max(0, min(len(p), total - o))
        buf[o:o + n] = p[:n]
        have[o:o + n] = True
    missing, i = [], 0
    while i < total:
        if have[i]:
            i += 1
            continue
        j = i
        while j < total and not have[j]:
            j += 1
        missing.append((i, j))
        i = j
    if missing:
        return Report(None, None, missing, pages, len(good) - len(mine), total=total, covered=int(have.sum()))
    if G.crc32(bytes(buf)) != fid:        # RS 가 잘못 맞춘 장이나 서로 어긋나는 겹침을 걸러낸다
        return Report(None, None, [], pages, len(good) - len(mine), crc_mismatch=True, total=total, covered=total)
    name, data = G.parse_stream(bytes(buf))
    return Report(name, data, [], pages, len(good) - len(mine), total=total, covered=total)


# ---------- 세션 (웹 페이지/서버용: 사진을 하나씩 더해 가며 진행 상황을 본다) ----------
class GridSession:
    def __init__(self):
        self.results = []

    def add_photo(self, data: bytes, name: str = "") -> dict:
        """사진 한 장(파일 바이트)을 더한다. 순서는 상관없다. 반환: 이 사진의 결과 요약."""
        info = dict(name=name, status="unreadable")
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return info
        res = read_photo(img)
        if res is None:
            return dict(info, status="no_grid")
        self.results.append(res)
        h = res.header
        return dict(info, status="ok" if res.ok else "rs_failed", cols=h.cols, rows=h.rows, levels=1 << h.log2l,
                    offset=h.offset, plen=h.plen, rs_corrected=res.rs_corrected,
                    cell_error_rate=None if res.cell_error_rate != res.cell_error_rate else res.cell_error_rate)

    def report(self) -> dict:
        r = assemble(self.results)
        return dict(done=r.data is not None, name=r.name, total=r.total, covered=r.covered,
                    missing=[list(m) for m in r.missing_ranges], crc_mismatch=r.crc_mismatch,
                    pages_ok=sum(1 for p in r.per_page if p["ok"]), skipped=r.skipped,
                    size=None if r.data is None else len(r.data))

    def result(self):
        """완료됐으면 (이름, 바이트), 아니면 None."""
        r = assemble(self.results)
        return None if r.data is None else (r.name, r.data)


# ---------- CLI ----------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("photos", nargs="+")
    ap.add_argument("-o", "--out", default=".", help="복원한 파일을 저장할 폴더")
    a = ap.parse_args(argv)
    results = []
    print(f"{'사진':<28}{'격자':>10}{'단계':>5}{'offset':>10}{'RS정정':>8}{'칸오류율':>10}  결과")
    for p in a.photos:
        img = cv2.imread(p)
        res = read_photo(img) if img is not None else None
        results.append(res)
        if res is None:
            print(f"{Path(p).name[:27]:<28}{'-':>10}{'-':>5}{'-':>10}{'-':>8}{'-':>10}  " + ("읽을 수 없음" if img is None else "격자를 찾지 못함"))
            continue
        h = res.header
        grid = f"{h.cols}x{h.rows}" if h else "-"
        print(f"{Path(p).name[:27]:<28}{grid:>10}{(1 << h.log2l) if h else '-':>5}{h.offset if h else '-':>10}"
              f"{res.rs_corrected:>8}{res.cell_error_rate * 100:>9.2f}%  {'OK' if res.ok else 'RS 복구 실패'}")
    rep = assemble(results)
    if rep.data is not None:
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        base = Path(rep.name).name                                   # 경로 성분 제거
        if base in ("", ".", "..") or any(ord(ch) < 32 for ch in base):
            base = "restored.bin"
        dest = out / base
        if dest.exists():
            print(f"복원은 성공했지만 {dest} 가 이미 있어 덮어쓰지 않습니다. 다른 폴더(-o)를 지정하세요.")
            return 1
        dest.write_bytes(rep.data)
        print(f"복원 성공: {dest} ({len(rep.data):,} B)")
        return 0
    if rep.crc_mismatch:
        print("복원 실패 — 모든 구간이 채워졌지만 CRC 가 맞지 않습니다 (오류가 많은 장이 잘못 복구됐거나 서로 다른 장이 겹침). 해당 장을 다시 찍으세요.")
    elif rep.missing_ranges:
        print("복원 실패 — 아직 없는 바이트 구간(스트림 기준):", ", ".join(f"{s}-{e}" for s, e in rep.missing_ranges))
    else:
        print("복원 실패 — 읽힌 장이 없습니다.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
