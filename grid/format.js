// 화면 격자 포맷 (JS 구현). tools/gridfmt.py 와 바이트 단위로 같아야 한다 (grid/test/fixtures.json 으로 고정).
import { rsEncode } from "./rs.js";

export const MIN_COLS = 90;
export const MIN_ROWS = 20;
const CORNER = 8;
const HEADER_CELLS = 72;
const HEADER_COL0 = CORNER;
const HEADER_LEN = 27;
const BLOCK = 255;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** 격자 설정. 최소 크기 미만이거나 RS 블록이 한 개도 안 들어가면 null. */
export function makeLayout(cols, rows, levels, rsRatio = 0.2) {
  if (![2, 4, 8].includes(levels) || cols < MIN_COLS || rows < MIN_ROWS) return null;
  const nsym = roundHalfEven(BLOCK * rsRatio);
  if (nsym < 2 || nsym > 200) return null;
  const log2l = Math.log2(levels);
  const bitsPerCell = 3 * log2l;
  const dataCells = cols * rows - 4 * CORNER * CORNER - (cols - 2 * CORNER) - HEADER_CELLS;
  const nBlocks = Math.floor(Math.floor((dataCells * bitsPerCell) / 8) / BLOCK);
  if (nBlocks < 1) return null;
  return { cols, rows, levels, log2l, nsym, bitsPerCell, dataCells, nBlocks, pageBytes: nBlocks * (BLOCK - nsym) };
}

function isReserved(l, r, c) {
  if ((r < CORNER || r >= l.rows - CORNER) && (c < CORNER || c >= l.cols - CORNER)) return true;
  if (r === 0 && c >= CORNER && c < l.cols - CORNER) return true;
  return r === 1 && c >= HEADER_COL0 && c < HEADER_COL0 + HEADER_CELLS;
}

/** 스트림 = u8 이름길이, 이름(utf-8), u32 크기, 파일 바이트. */
export function buildStream(name, data) {
  const nb = new TextEncoder().encode(name);
  if (nb.length > 255) throw new RangeError("file name too long (max 255 bytes in utf-8)");
  const out = new Uint8Array(1 + nb.length + 4 + data.length);
  out[0] = nb.length;
  out.set(nb, 1);
  new DataView(out.buffer).setUint32(1 + nb.length, data.length);
  out.set(data, 5 + nb.length);
  return out;
}

function encodeHeader(h) {
  const out = new Uint8Array(HEADER_LEN);
  const v = new DataView(out.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, h.log2l);
  v.setUint16(2, h.cols);
  v.setUint16(4, h.rows);
  v.setUint8(6, h.nsym);
  v.setUint32(7, h.fileId);
  v.setUint32(11, h.offset);
  v.setUint32(15, h.total);
  v.setUint32(19, h.plen);
  v.setUint32(23, crc32(out.subarray(0, 23)));
  return out;
}

function baseCells(l) {
  const cells = new Uint8Array(l.rows * l.cols * 3);
  const white = l.levels - 1;
  const set = (r, c, R, G, B) => {
    const i = (r * l.cols + c) * 3;
    cells[i] = R;
    cells[i + 1] = G;
    cells[i + 2] = B;
  };
  for (const [r0, c0] of [[0, 0], [0, l.cols - CORNER], [l.rows - CORNER, 0], [l.rows - CORNER, l.cols - CORNER]]) {
    for (let i = 0; i < CORNER; i++) {
      for (let j = 0; j < CORNER; j++) {
        const layer = Math.min(i, CORNER - 1 - i, j, CORNER - 1 - j);
        const v = layer % 2 === 0 ? white : 0;
        set(r0 + i, c0 + j, v, v, v);
      }
    }
  }
  const pattern = [[0, 0, 0], [white, white, white]];
  for (let ch = 0; ch < 3; ch++) {
    for (let k = 0; k < l.levels; k++) {
      const v = [0, 0, 0];
      v[ch] = k;
      pattern.push(v);
    }
  }
  for (let c = CORNER; c < l.cols - CORNER; c++) set(0, c, ...pattern[(c - CORNER) % pattern.length]);
  return cells;
}

/** bytes 를 비트(MSB 우선)로 읽어 칸마다 R,G,B 에 log2l 비트씩 채운다. 모자라는 비트는 0. */
function writeBits(bytes, log2l, cellCount, put) {
  let bit = 0;
  const total = bytes.length * 8;
  const next = () => {
    const b = bit < total ? (bytes[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
    bit++;
    return b;
  };
  for (let n = 0; n < cellCount; n++) {
    const v = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) for (let k = 0; k < log2l; k++) v[ch] = (v[ch] << 1) | next();
    put(n, v);
  }
}

/** 한 장의 격자. cells = rows*cols*3 단계 인덱스(0..levels-1). */
export function renderPage(layout, stream, offset) {
  const l = layout;
  const k = BLOCK - l.nsym;
  const chunk = stream.subarray(offset, offset + l.pageBytes);
  const padded = new Uint8Array(l.pageBytes);
  padded.set(chunk);
  const inter = new Uint8Array(l.nBlocks * BLOCK);
  for (let b = 0; b < l.nBlocks; b++) {
    const cw = rsEncode(padded.subarray(b * k, (b + 1) * k), l.nsym);
    for (let j = 0; j < BLOCK; j++) inter[j * l.nBlocks + b] = cw[j];
  }
  const header = { fileId: crc32(stream), offset, total: stream.length, plen: chunk.length };
  const hdrBytes = encodeHeader({ log2l: l.log2l, cols: l.cols, rows: l.rows, nsym: l.nsym, ...header });

  const cells = baseCells(l);
  const white = l.levels - 1;
  writeBits(hdrBytes, 1, HEADER_CELLS, (n, v) => {
    const i = (1 * l.cols + HEADER_COL0 + n) * 3;
    cells[i] = v[0] * white;
    cells[i + 1] = v[1] * white;
    cells[i + 2] = v[2] * white;
  });
  const idx = [];
  for (let r = 0; r < l.rows; r++) for (let c = 0; c < l.cols; c++) if (!isReserved(l, r, c)) idx.push((r * l.cols + c) * 3);
  writeBits(inter, l.log2l, idx.length, (n, v) => {
    cells[idx[n]] = v[0];
    cells[idx[n] + 1] = v[1];
    cells[idx[n] + 2] = v[2];
  });
  return { cells, header };
}
