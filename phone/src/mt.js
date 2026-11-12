// CPython random.Random(seed).getrandbits(k) 와 비트 단위로 같은 MT19937.
const N = 624;
const M = 397;

export class PyMT {
  /** @param {bigint} seed 0 이상의 정수 시드 */
  constructor(seed) {
    this.mt = new Uint32Array(N);
    this.idx = N;
    const key = [];
    let s = seed < 0n ? -seed : seed;
    if (s === 0n) key.push(0);
    while (s > 0n) {
      key.push(Number(s & 0xffffffffn));
      s >>= 32n;
    }
    this.#initByArray(key);
  }

  #initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
  }

  #initByArray(key) {
    const mt = this.mt;
    this.#initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.idx = N;
  }

  #twist() {
    const mt = this.mt;
    for (let k = 0; k < N; k++) {
      const y = (mt[k] & 0x80000000) | (mt[(k + 1) % N] & 0x7fffffff);
      mt[k] = mt[(k + M) % N] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
    }
    this.idx = 0;
  }

  genrand() {
    if (this.idx >= N) this.#twist();
    let y = this.mt[this.idx++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** @returns {bigint} */
  getrandbits(k) {
    if (k <= 32) return BigInt(this.genrand() >>> (32 - k));
    const words = Math.floor((k - 1) / 32) + 1;
    let x = 0n;
    for (let i = 0; i < words; i++) {
      let r = this.genrand();
      if (k < 32) r >>>= 32 - k;
      x |= BigInt(r) << BigInt(32 * i);
      k -= 32;
    }
    return x;
  }
}

/** 프레임 idx 가 담는 블록 비트마스크 (qr_codec._coef 와 동일). */
export function coefMask(k, crc, idx) {
  if (idx < k) return 1n << BigInt(idx);
  const v = new PyMT((BigInt(crc) << 32n) | BigInt(idx)).getrandbits(k);
  return v || 1n << BigInt(idx % k);
}
