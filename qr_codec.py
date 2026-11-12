"""파일 <-> 애니메이션 QR 프레임 코덱.

 - 파일을 블록으로 나누고, 처음 K개 프레임은 원본 블록(systematic), 이후 프레임은 무작위로 고른
   블록들의 XOR(GF(2) 선형 결합, fountain code)이다. 어느 프레임을 놓쳐도 서로 다른 프레임이 K+2개 안팎이면 복원된다.
 - 프레임은 Base45(QR 영숫자 모드 문자 집합)로 써서 어떤 QR 디코더에서도 바이너리 깨짐이 없다.
 - 생성은 segno, 해독은 OpenCV (둘 다 선택 의존성: pip install segno opencv-python-headless numpy)
"""
from __future__ import annotations

import base64
import random
import struct
import zlib
from dataclasses import dataclass

B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
HDR = struct.Struct(">BHIIIH")        # 버전, K, 파일크기, 파일CRC32, 프레임번호, 프레임CRC16
VERSION = 1
HDR_LEN = HDR.size                    # 17


# ---------------- Base45 (RFC 9285) ----------------
def b45encode(data: bytes) -> str:
    out = []
    for i in range(0, len(data), 2):
        if i + 1 < len(data):
            n = data[i] * 256 + data[i + 1]
            n, c = divmod(n, 45)
            e, d = divmod(n, 45)
            out += [B45[c], B45[d], B45[e]]
        else:
            d, c = divmod(data[i], 45)
            out += [B45[c], B45[d]]
    return "".join(out)


def b45decode(s: str) -> bytes:
    if len(s) % 3 == 1:
        raise ValueError("Base45 길이 오류")
    vals = [B45.index(c) for c in s]
    out = bytearray()
    for i in range(0, len(vals), 3):
        g = vals[i:i + 3]
        if len(g) == 3:
            n = g[0] + g[1] * 45 + g[2] * 2025
            if n > 0xFFFF:
                raise ValueError("Base45 값 범위 오류")
            out += n.to_bytes(2, "big")
        else:
            n = g[0] + g[1] * 45
            if n > 0xFF:
                raise ValueError("Base45 값 범위 오류")
            out.append(n)
    return bytes(out)


# ---------------- fountain (선형 결합) ----------------
def _coef(k: int, crc: int, idx: int) -> int:
    """프레임 idx 가 포함하는 블록 비트마스크. idx<K 는 원본 블록 하나, 이후는 난수(밀도 1/2)."""
    if idx < k:
        return 1 << idx
    v = random.Random((crc << 32) | idx).getrandbits(k)
    return v or (1 << (idx % k))


class Encoder:
    def __init__(self, data: bytes, block_size: int):
        self.size, self.crc, self.bs = len(data), zlib.crc32(data), block_size
        self.k = max(1, -(-len(data) // block_size))
        if self.k > 0xFFFF:
            raise ValueError("파일이 너무 큽니다 (블록 수 65535 초과)")
        padded = data.ljust(self.k * block_size, b"\0")
        self.blocks = [int.from_bytes(padded[i * block_size:(i + 1) * block_size], "big") for i in range(self.k)]

    def frame(self, idx: int) -> bytes:
        mask, acc, i = _coef(self.k, self.crc, idx), 0, 0
        while mask:
            if mask & 1:
                acc ^= self.blocks[i]
            mask >>= 1
            i += 1
        payload = acc.to_bytes(self.bs, "big")
        head = HDR.pack(VERSION, self.k, self.size, self.crc, idx, 0)
        c16 = zlib.crc32(head[:-2] + payload) & 0xFFFF
        return head[:-2] + struct.pack(">H", c16) + payload

    def text(self, idx: int) -> str:
        return b45encode(self.frame(idx))


class Decoder:
    """프레임을 하나씩 넣으면 GF(2) 가우스 소거로 블록을 복원한다."""

    def __init__(self):
        self.k = self.size = self.crc = self.bs = None
        self.basis: dict[int, tuple[int, int]] = {}     # 최고 비트 -> (계수, 데이터)
        self.seen: set[int] = set()
        self.stats = dict(new=0, dup=0, bad=0, other=0, redundant=0)

    @property
    def rank(self) -> int:
        return len(self.basis)

    def add_text(self, text: str) -> str:
        try:
            return self.add(b45decode(text.strip("\r\n\t")))
        except (ValueError, IndexError):
            self.stats["bad"] += 1
            return "bad"

    def add(self, frame: bytes) -> str:
        if len(frame) <= HDR_LEN:
            self.stats["bad"] += 1
            return "bad"
        ver, k, size, crc, idx, c16 = HDR.unpack(frame[:HDR_LEN])
        payload = frame[HDR_LEN:]
        if ver != VERSION or k == 0 or zlib.crc32(frame[:HDR_LEN - 2] + payload) & 0xFFFF != c16:
            self.stats["bad"] += 1
            return "bad"
        if self.k is None:
            self.k, self.size, self.crc, self.bs = k, size, crc, len(payload)
        elif (k, size, crc, len(payload)) != (self.k, self.size, self.crc, self.bs):
            self.stats["other"] += 1
            return "other"
        if idx in self.seen:
            self.stats["dup"] += 1
            return "dup"
        self.seen.add(idx)
        coef, data = _coef(k, crc, idx), int.from_bytes(payload, "big")
        while coef:
            p = coef.bit_length() - 1
            if p in self.basis:
                bc, bd = self.basis[p]
                coef ^= bc
                data ^= bd
            else:
                self.basis[p] = (coef, data)
                self.stats["new"] += 1
                return "new"
        self.stats["redundant"] += 1
        return "redundant"

    @property
    def done(self) -> bool:
        return self.k is not None and self.rank == self.k

    def result(self) -> bytes | None:
        """모든 블록이 모였고 전체 CRC32 가 맞으면 원본 바이트, 아니면 None."""
        if not self.done:
            return None
        blocks: list[int] = [0] * self.k
        for p in range(self.k):
            coef, data = self.basis[p]
            rest = coef ^ (1 << p)
            while rest:
                b = rest.bit_length() - 1
                data ^= blocks[b]
                rest ^= 1 << b
            blocks[p] = data
        raw = b"".join(b.to_bytes(self.bs, "big") for b in blocks)[:self.size]
        return raw if zlib.crc32(raw) == self.crc else None


# ---------------- QR 생성 ----------------
_cap_cache: dict[tuple[int, str], int] = {}


def capacity_chars(version: int, ecc: str) -> int:
    """고정 버전 QR 에 영숫자 모드로 넣을 수 있는 최대 글자 수."""
    import segno
    key = (version, ecc)
    if key not in _cap_cache:
        lo, hi = 10, 4000
        while lo < hi:
            mid = (lo + hi + 1) // 2
            try:
                segno.make_qr("A" * mid, mode="alphanumeric", error=ecc, version=version, boost_error=False)
                lo = mid
            except Exception:
                hi = mid - 1
        _cap_cache[key] = lo
    return _cap_cache[key]


def block_size_for(version: int, ecc: str) -> int:
    """프레임 한 개가 해당 버전 QR 에 정확히 들어가도록 하는 블록(페이로드) 바이트 수."""
    chars = capacity_chars(version, ecc)
    frame_bytes = (chars // 3) * 2          # Base45: 3글자 = 2바이트
    return frame_bytes - HDR_LEN


def qr_matrix(text: str, version: int, ecc: str) -> list[bytearray]:
    import segno
    q = segno.make_qr(text, mode="alphanumeric", error=ecc, version=version, boost_error=False)
    return [bytearray(r) for r in q.matrix]


def pack_matrix(m: list[bytearray]) -> str:
    """0/1 행렬을 비트로 묶어 base64 로 (웹 전송용)."""
    bits = "".join("".join("1" if v else "0" for v in row) for row in m)
    bits += "0" * (-len(bits) % 8)
    return base64.b64encode(int(bits, 2).to_bytes(len(bits) // 8, "big")).decode()


@dataclass
class QRStream:
    version: int
    ecc: str
    block_size: int
    k: int
    n_frames: int
    modules: int
    frames: list[str]            # pack_matrix 결과


def make_stream(data: bytes, version: int = 15, ecc: str = "M", repair: float = 0.5) -> QRStream:
    enc = Encoder(data, block_size_for(version, ecc))
    n = enc.k + max(3, int(enc.k * repair + 0.999))
    frames = [pack_matrix(qr_matrix(enc.text(i), version, ecc)) for i in range(n)]
    return QRStream(version, ecc, enc.bs, enc.k, n, 17 + 4 * version, frames)


# ---------------- QR 해독 (zxing-cpp + OpenCV 입출력) ----------------
# 실측: 폰으로 모니터를 찍은 720p 영상(모듈당 약 4px)에서 OpenCV 의 QR 디코더는 0프레임을 읽었고,
#       zxing-cpp 는 3배 확대에서 읽혔다. 다만 zxing-cpp 는 특정 프레임에서 멈추는(hang) 경우가 있어서
#       해독은 별도 프로세스에서 하고 프레임마다 제한 시간을 둔다.
SCAN_LONG_SIDES = (3840, 5120, 3200, 2560)       # 긴 변을 이 크기로 맞춰 차례로 시도 (성공하면 중단)
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def scan_image(img) -> list[str]:
    """이미지(ndarray) 한 장에서 QR 텍스트를 읽는다. 크기를 바꿔 가며 시도한다. (멈춤 보호 없음: 직접 쓰지 말고 scan_file 사용)"""
    import cv2
    import zxingcpp
    h, w = img.shape[:2]
    for target in SCAN_LONG_SIDES:
        k = target / max(h, w)
        im = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_CUBIC if k > 1 else cv2.INTER_AREA)
        out = [r.text for r in zxingcpp.read_barcodes(im, formats=zxingcpp.BarcodeFormat.QRCode) if r.text]
        if out:
            return list(dict.fromkeys(out))
    return []


def _frames(path: str, start: int, step: int):
    """(프레임번호, ndarray) 를 순서대로. 이미지 파일은 한 장."""
    import cv2
    from pathlib import Path
    if Path(path).suffix.lower() in IMAGE_EXT:
        img = cv2.imread(path)
        if img is None:
            raise RuntimeError("이미지를 열 수 없습니다.")
        yield 0, img
        return
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError("영상을 열 수 없습니다 (코덱 미지원일 수 있음: ffmpeg 로 mp4/H.264 변환 후 시도)")
    if start:
        cap.set(cv2.CAP_PROP_POS_FRAMES, start)
    i = start
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                return
            if i % step == 0:
                yield i, frame
            i += 1
    finally:
        cap.release()


def _worker(path: str, start: int, step: int, conn, hang_at: int = -1):
    """별도 프로세스: 프레임마다 begin/done 을 보낸다. begin 후 done 이 오지 않으면 부모가 멈춘 것으로 보고 종료시킨다."""
    import time
    try:
        for i, frame in _frames(path, start, step):
            conn.send(("begin", i, []))
            if i == hang_at:                       # 시험용: 멈춤 재현
                time.sleep(3600)
            conn.send(("done", i, scan_image(frame)))
        conn.send(("end", -1, []))
    except Exception as e:                         # 파일을 못 여는 등
        conn.send(("error", -1, [str(e)]))


def scan_file(path: str, dec: Decoder | None = None, step: int = 1, on_progress=None,
              frame_timeout: float = 3.0, start_timeout: float = 30.0, max_hangs: int = 20, _hang_at: int = -1) -> Decoder:
    """영상/사진 파일의 QR 을 읽어 Decoder 에 넣는다. 완성되면 즉시 멈춘다.
    해독은 자식 프로세스에서 하며, 한 프레임이 frame_timeout 초 넘게 멈추면 프로세스를 죽이고 다음 프레임부터 재개한다."""
    import multiprocessing as mp
    import time
    dec = dec or Decoder()
    ctx = mp.get_context("spawn")
    dec.stats.setdefault("hang", 0)
    start, cur = 0, 0
    while True:
        parent, child = ctx.Pipe(duplex=False)
        proc = ctx.Process(target=_worker, args=(path, start, max(1, step), child, _hang_at), daemon=True)
        proc.start()
        child.close()
        finished, waiting = False, start_timeout       # 첫 응답은 import 시간 때문에 넉넉히
        try:
            while True:
                if not parent.poll(waiting):
                    dec.stats["hang"] += 1             # 응답 없음 -> 멈춘 프레임
                    break
                kind, i, texts = parent.recv()
                waiting = frame_timeout
                if kind == "error":
                    raise RuntimeError(texts[0])
                if kind == "end":
                    finished = True
                    break
                if kind == "begin":
                    cur = i
                    continue
                cur = i
                for t in texts:
                    dec.add_text(t)
                if on_progress:
                    on_progress(i, dec)
                if dec.done and dec.result() is not None:
                    finished = True
                    break
        finally:
            proc.kill()
            proc.join()
        if finished or dec.stats["hang"] > max_hangs:
            return dec
        start = cur + 1


# ---------------- 렌더 / 영상 저장 (CLI·시험용) ----------------
def unpack_matrix(packed: str, modules: int) -> list[bytearray]:
    raw = base64.b64decode(packed)
    bits = bin(int.from_bytes(raw, "big"))[2:].zfill(len(raw) * 8)[:modules * modules]
    return [bytearray(int(c) for c in bits[r * modules:(r + 1) * modules]) for r in range(modules)]


def render(m: list[bytearray], scale: int = 6, quiet: int = 4):
    """QR 행렬 -> 흰 바탕/검정 모듈 그레이스케일 ndarray (조용한 영역 포함)."""
    import numpy as np
    a = np.array([list(r) for r in m], dtype=np.uint8)
    a = np.pad(a, quiet, constant_values=0)
    return np.kron(1 - a, np.ones((scale, scale), dtype=np.uint8)) * 255


def write_video(stream: QRStream, path: str, fps: int = 8, scale: int = 8, loops: int = 2, size: int = 1080, video_fps: int = 30):
    """프레임을 반복 재생하는 mp4 를 저장 (화면 녹화 대신 파일로 전달할 때).
    QR 은 초당 fps 장 바뀌고, 영상은 video_fps 로 저장되어 각 QR 이 여러 영상 프레임에 걸쳐 유지된다(실제 촬영과 동일)."""
    import cv2
    import numpy as np
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), video_fps, (size, size))
    if not vw.isOpened():
        raise RuntimeError("mp4 저장 실패")
    hold = max(1, round(video_fps / fps))
    for _ in range(loops):
        for p in stream.frames:
            img = render(unpack_matrix(p, stream.modules), scale)
            s = min(size, img.shape[0] * max(1, size // img.shape[0]))
            img = cv2.resize(img, (s, s), interpolation=cv2.INTER_NEAREST)
            canvas = np.full((size, size), 255, np.uint8)
            o = (size - s) // 2
            canvas[o:o + s, o:o + s] = img
            bgr = cv2.cvtColor(canvas, cv2.COLOR_GRAY2BGR)
            for _ in range(hold):
                vw.write(bgr)
    vw.release()
