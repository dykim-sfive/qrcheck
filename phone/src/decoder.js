// qr_codec.Decoder 의 JS 포트: 프레임 검증 + GF(2) 가우스 소거 + 전체 CRC32 확인.
import { b45decode } from "./base45.js";
import { crc32 } from "./crc.js";
import { coefMask } from "./mt.js";

const HDR_LEN = 17; // >BHIIIH : 버전, K, 파일크기, 파일CRC32, 프레임번호, 프레임CRC16
const VERSION = 1;

function bytesToBig(bytes) {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex ? BigInt("0x" + hex) : 0n;
}

function bigToBytes(n, len) {
  const hex = n.toString(16).padStart(len * 2, "0");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export class Decoder {
  constructor() {
    this.reset();
  }

  reset() {
    this.k = this.size = this.crc = this.bs = null;
    this.basis = new Map(); // 최고 비트 -> [계수, 데이터]
    this.seen = new Set();
    this.stats = { new: 0, dup: 0, bad: 0, other: 0, redundant: 0 };
    this._result = undefined;
  }

  get rank() {
    return this.basis.size;
  }

  get done() {
    return this.k !== null && this.rank === this.k;
  }

  get crcFailed() {
    return this.done && this.result() === null;
  }

  /** @returns {"new"|"dup"|"redundant"|"bad"|"other"} */
  addText(text) {
    try {
      // 공백(0x20)은 Base45 문자이므로 trim() 하면 안 된다: 줄바꿈/탭만 제거
      return this.add(b45decode(text.replace(/^[\r\n\t]+|[\r\n\t]+$/g, "")));
    } catch {
      this.stats.bad++;
      return "bad";
    }
  }

  add(frame) {
    if (frame.length <= HDR_LEN) return this.#count("bad");
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const ver = dv.getUint8(0);
    const k = dv.getUint16(1);
    const size = dv.getUint32(3);
    const crc = dv.getUint32(7);
    const idx = dv.getUint32(11);
    const c16 = dv.getUint16(15);
    const payload = frame.subarray(HDR_LEN);
    const body = new Uint8Array(HDR_LEN - 2 + payload.length);
    body.set(frame.subarray(0, HDR_LEN - 2));
    body.set(payload, HDR_LEN - 2);
    if (ver !== VERSION || k === 0 || (crc32(body) & 0xffff) !== c16) return this.#count("bad");

    if (this.k === null) {
      this.k = k;
      this.size = size;
      this.crc = crc;
      this.bs = payload.length;
    } else if (k !== this.k || size !== this.size || crc !== this.crc || payload.length !== this.bs) {
      return this.#count("other");
    }
    if (this.seen.has(idx)) return this.#count("dup");
    this.seen.add(idx);

    let coef = coefMask(k, crc, idx);
    let data = bytesToBig(payload);
    while (coef) {
      const p = coef.toString(2).length - 1;
      const row = this.basis.get(p);
      if (row) {
        coef ^= row[0];
        data ^= row[1];
      } else {
        this.basis.set(p, [coef, data]);
        this._result = undefined;
        return this.#count("new");
      }
    }
    return this.#count("redundant");
  }

  #count(kind) {
    this.stats[kind]++;
    return kind;
  }

  /** 모두 모였고 전체 CRC32 가 맞으면 원본 바이트, 아니면 null. */
  result() {
    if (!this.done) return null;
    if (this._result !== undefined) return this._result;
    const blocks = new Array(this.k).fill(0n);
    for (let p = 0; p < this.k; p++) {
      let [coef, data] = this.basis.get(p);
      let rest = coef ^ (1n << BigInt(p));
      while (rest) {
        const b = rest.toString(2).length - 1;
        data ^= blocks[b];
        rest ^= 1n << BigInt(b);
      }
      blocks[p] = data;
    }
    const raw = new Uint8Array(this.k * this.bs);
    blocks.forEach((b, i) => raw.set(bigToBytes(b, this.bs), i * this.bs));
    const out = raw.subarray(0, this.size);
    this._result = crc32(out) === this.crc ? out : null;
    return this._result;
  }
}
