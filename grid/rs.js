// Reed-Solomon 인코더 (GF(256), prim 0x11d, generator 2, fcr 0) — Python reedsolo.RSCodec 와 같은 결과.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

const generators = new Map();
function generator(nsym) {
  let g = generators.get(nsym);
  if (g) return g;
  g = [1];
  for (let i = 0; i < nsym; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  generators.set(nsym, g);
  return g;
}

/** data + 패리티(nsym 바이트)를 돌려준다. data.length + nsym <= 255. */
export function rsEncode(data, nsym) {
  if (data.length + nsym > 255) throw new RangeError("RS block too long");
  const gen = generator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
    }
  }
  out.set(data); // 위 계산은 앞부분을 덮어쓰므로 원본 데이터를 복원한다
  return out;
}
