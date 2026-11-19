"""화면 격자 전송 포맷 (Python 구현). 규격은 docs/superpowers/plans/2026-11-20-screen-grid.md 의 '포맷 정의'.

격자 = (rows, cols, 3) uint8 '단계 인덱스'(0..levels-1). JS 구현(grid/format.js)과 바이트 단위로 같아야 한다.
"""
from __future__ import annotations

import math
import struct
import zlib
from dataclasses import dataclass

import numpy as np
from reedsolo import RSCodec, ReedSolomonError

MIN_COLS, MIN_ROWS = 90, 20
CORNER = 8                     # 코너 블록 한 변(칸)
HEADER_CELLS = 72
HEADER_COL0 = CORNER           # 헤더 시작 열 (행 1)
HEADER_LEN = 27
BLOCK = 255
_HDR = struct.Struct(">BBHHBIIII")   # ver, log2l, cols, rows, nsym, file_id, offset, total, plen  (23바이트)


def crc32(b: bytes) -> int:
    return zlib.crc32(b) & 0xFFFFFFFF


@dataclass(frozen=True)
class Layout:
    cols: int
    rows: int
    levels: int
    nsym: int

    @property
    def log2l(self) -> int:
        return self.levels.bit_length() - 1

    @property
    def bits_per_cell(self) -> int:
        return 3 * self.log2l

    @property
    def data_cells(self) -> int:
        return self.cols * self.rows - 4 * CORNER * CORNER - (self.cols - 2 * CORNER) - HEADER_CELLS

    @property
    def n_blocks(self) -> int:
        return (self.data_cells * self.bits_per_cell // 8) // BLOCK

    @property
    def page_bytes(self) -> int:
        return self.n_blocks * (BLOCK - self.nsym)


def make_layout(cols: int, rows: int, levels: int, rs_ratio: float = 0.2) -> Layout:
    if levels not in (2, 4, 8):
        raise ValueError("levels must be 2, 4 or 8")
    if cols < MIN_COLS or rows < MIN_ROWS:
        raise ValueError(f"grid too small (min {MIN_COLS}x{MIN_ROWS})")
    nsym = round(BLOCK * rs_ratio)
    if not 2 <= nsym <= 200:
        raise ValueError("rs_ratio out of range")
    lay = Layout(cols, rows, levels, nsym)
    if lay.n_blocks < 1:
        raise ValueError("grid too small for one RS block")
    return lay


def is_reserved(layout: Layout, r: int, c: int) -> bool:
    cols, rows = layout.cols, layout.rows
    if (r < CORNER or r >= rows - CORNER) and (c < CORNER or c >= cols - CORNER):
        return True
    if r == 0 and CORNER <= c < cols - CORNER:
        return True
    return r == 1 and HEADER_COL0 <= c < HEADER_COL0 + HEADER_CELLS


def reserved_mask(layout: Layout) -> np.ndarray:
    m = np.zeros((layout.rows, layout.cols), bool)
    m[:CORNER, :CORNER] = m[:CORNER, -CORNER:] = m[-CORNER:, :CORNER] = m[-CORNER:, -CORNER:] = True
    m[0, CORNER:layout.cols - CORNER] = True
    m[1, HEADER_COL0:HEADER_COL0 + HEADER_CELLS] = True
    return m


# ---- 스트림 ----
def build_stream(name: str, data: bytes) -> bytes:
    nb = name.encode("utf-8")
    if len(nb) > 255:
        raise ValueError("file name too long (max 255 bytes in utf-8)")
    return bytes([len(nb)]) + nb + struct.pack(">I", len(data)) + data


def parse_stream(stream: bytes) -> tuple[str, bytes]:
    n = stream[0]
    name = stream[1:1 + n].decode("utf-8")
    (size,) = struct.unpack(">I", stream[1 + n:5 + n])
    data = stream[5 + n:5 + n + size]
    if len(data) != size:
        raise ValueError("stream truncated")
    return name, data


# ---- 헤더 ----
@dataclass(frozen=True)
class Header:
    log2l: int
    cols: int
    rows: int
    nsym: int
    file_id: int
    offset: int
    total: int
    plen: int


def encode_header(h: Header) -> bytes:
    body = _HDR.pack(1, h.log2l, h.cols, h.rows, h.nsym, h.file_id, h.offset, h.total, h.plen)
    return body + struct.pack(">I", crc32(body))


def decode_header(b: bytes) -> Header | None:
    if len(b) < HEADER_LEN:
        return None
    body = b[:_HDR.size]
    if struct.unpack(">I", b[_HDR.size:HEADER_LEN])[0] != crc32(body):
        return None
    ver, log2l, cols, rows, nsym, fid, off, total, plen = _HDR.unpack(body)
    if ver != 1 or log2l not in (1, 2, 3):
        return None
    return Header(log2l, cols, rows, nsym, fid, off, total, plen)


# ---- 비트 <-> 칸 ----
def _bytes_to_levels(data: bytes, n_cells: int, log2l: int) -> np.ndarray:
    """바이트 -> (n_cells, 3) 단계 값. 비트는 MSB 우선, 칸마다 R,G,B 순, 모자라면 0."""
    bits = np.unpackbits(np.frombuffer(data, np.uint8))
    need = n_cells * 3 * log2l
    bits = np.concatenate([bits, np.zeros(max(0, need - len(bits)), np.uint8)])[:need]
    w = 1 << np.arange(log2l - 1, -1, -1)
    return (bits.reshape(n_cells, 3, log2l) * w).sum(axis=2).astype(np.uint8)


def _levels_to_bytes(vals: np.ndarray, log2l: int) -> bytes:
    shifts = np.arange(log2l - 1, -1, -1)
    bits = ((vals[:, :, None].astype(np.uint8) >> shifts) & 1).astype(np.uint8).reshape(-1)
    bits = bits[:len(bits) // 8 * 8]
    return np.packbits(bits).tobytes()


def _header_to_cells(raw: bytes, levels: int) -> np.ndarray:
    bits = np.unpackbits(np.frombuffer(raw, np.uint8))
    bits = np.concatenate([bits, np.zeros(HEADER_CELLS * 3 - len(bits), np.uint8)])
    return (bits.reshape(HEADER_CELLS, 3) * (levels - 1)).astype(np.uint8)


def _cells_to_header_bytes(vals: np.ndarray, levels: int) -> bytes:
    bits = (vals.reshape(-1) * 2 >= levels).astype(np.uint8)   # 중간값 이상이면 1
    return np.packbits(bits[:HEADER_LEN * 8]).tobytes()


# ---- 페이지 ----
def _base_cells(layout: Layout) -> np.ndarray:
    L = layout.levels
    cells = np.zeros((layout.rows, layout.cols, 3), np.uint8)
    white = L - 1
    blk = np.zeros((CORNER, CORNER, 3), np.uint8)
    for i in range(CORNER):
        for j in range(CORNER):
            layer = min(i, CORNER - 1 - i, j, CORNER - 1 - j)
            blk[i, j] = white if layer % 2 == 0 else 0
    cells[:CORNER, :CORNER] = cells[:CORNER, -CORNER:] = blk
    cells[-CORNER:, :CORNER] = cells[-CORNER:, -CORNER:] = blk
    pattern = [(0, 0, 0), (white,) * 3]
    for ch in range(3):
        for k in range(L):
            v = [0, 0, 0]
            v[ch] = k
            pattern.append(tuple(v))
    for c in range(CORNER, layout.cols - CORNER):
        cells[0, c] = pattern[(c - CORNER) % len(pattern)]
    return cells


def _compose(layout: Layout, hdr: Header, padded: bytes) -> np.ndarray:
    """padded = 장당 page_bytes 바이트(0 패딩 포함). 격자 전체를 만든다."""
    k = BLOCK - layout.nsym
    nb = layout.n_blocks
    rs = RSCodec(layout.nsym)
    codewords = [bytes(rs.encode(padded[b * k:(b + 1) * k])) for b in range(nb)]
    inter = bytearray(nb * BLOCK)
    for b, cw in enumerate(codewords):
        inter[b::nb] = cw
    cells = _base_cells(layout)
    cells[1, HEADER_COL0:HEADER_COL0 + HEADER_CELLS] = _header_to_cells(encode_header(hdr), layout.levels)
    rr, cc = np.nonzero(~reserved_mask(layout))
    vals = _bytes_to_levels(bytes(inter), len(rr), layout.log2l)
    cells[rr, cc] = vals
    return cells


def render_page(layout: Layout, stream: bytes, offset: int) -> np.ndarray:
    chunk = stream[offset:offset + layout.page_bytes]
    hdr = Header(layout.log2l, layout.cols, layout.rows, layout.nsym, crc32(stream), offset, len(stream), len(chunk))
    return _compose(layout, hdr, chunk.ljust(layout.page_bytes, b"\x00"))


@dataclass
class PageResult:
    ok: bool
    header: Header | None = None
    payload: bytes = b""
    rs_corrected: int = 0
    cell_error_rate: float = math.nan


def read_header_cells(cells: np.ndarray, levels: int) -> Header | None:
    vals = cells[1, HEADER_COL0:HEADER_COL0 + HEADER_CELLS]
    return decode_header(_cells_to_header_bytes(vals, levels))


def decode_cells(cells: np.ndarray, levels: int) -> PageResult:
    """분류가 끝난 (rows, cols, 3) 단계 인덱스 -> 한 장의 페이로드. 실패하면 ok=False."""
    hdr = read_header_cells(cells, levels)
    if hdr is None or (1 << hdr.log2l) != levels or (hdr.rows, hdr.cols) != cells.shape[:2]:
        return PageResult(False, hdr)
    try:
        layout = Layout(hdr.cols, hdr.rows, levels, hdr.nsym)
        if layout.n_blocks < 1 or hdr.plen > layout.page_bytes:
            return PageResult(False, hdr)
    except ValueError:
        return PageResult(False, hdr)
    rr, cc = np.nonzero(~reserved_mask(layout))
    raw = _levels_to_bytes(cells[rr, cc], layout.log2l)
    nb = layout.n_blocks
    inter = raw[:nb * BLOCK]
    rs, msg, fixed = RSCodec(layout.nsym), bytearray(), 0
    try:
        for b in range(nb):
            m, _, errata = rs.decode(bytes(inter[b::nb]))
            msg += m
            fixed += len(errata)
    except ReedSolomonError:
        return PageResult(False, hdr)
    expect = _compose(layout, hdr, bytes(msg))
    wrong = (expect[rr, cc] != cells[rr, cc]).any(axis=1).mean()
    return PageResult(True, hdr, bytes(msg[:hdr.plen]), fixed, float(wrong))
