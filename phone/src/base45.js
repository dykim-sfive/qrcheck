// Base45 (RFC 9285)
export const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const INDEX = new Map([...B45].map((c, i) => [c, i]));

export function b45encode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      let n = bytes[i] * 256 + bytes[i + 1];
      const c = n % 45;
      n = (n - c) / 45;
      const d = n % 45;
      const e = (n - d) / 45;
      out += B45[c] + B45[d] + B45[e];
    } else {
      out += B45[bytes[i] % 45] + B45[Math.floor(bytes[i] / 45)];
    }
  }
  return out;
}

export function b45decode(s) {
  if (s.length % 3 === 1) throw new Error("Base45 길이 오류");
  const vals = [];
  for (const ch of s) {
    const v = INDEX.get(ch);
    if (v === undefined) throw new Error("Base45 문자 오류");
    vals.push(v);
  }
  const out = [];
  for (let i = 0; i < vals.length; i += 3) {
    if (i + 2 < vals.length) {
      const n = vals[i] + vals[i + 1] * 45 + vals[i + 2] * 2025;
      if (n > 0xffff) throw new Error("Base45 값 범위 오류");
      out.push(n >> 8, n & 0xff);
    } else {
      const n = vals[i] + vals[i + 1] * 45;
      if (n > 0xff) throw new Error("Base45 값 범위 오류");
      out.push(n);
    }
  }
  return Uint8Array.from(out);
}
