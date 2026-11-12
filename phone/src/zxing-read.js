// zxing-wasm 으로 QR 을 읽는 얇은 래퍼. Worker(브라우저)와 Node 테스트가 함께 쓴다.
import { prepareZXingModule, readBarcodes } from "../vendor/zxing-wasm/reader/index.js";

let ready = null;

/** @param {{wasmUrl?: string, wasmBinary?: Uint8Array}} src 브라우저는 wasmUrl, Node 는 wasmBinary */
export function initZXing({ wasmUrl, wasmBinary } = {}) {
  if (!ready) {
    const overrides = wasmBinary ? { wasmBinary } : { locateFile: (path, prefix) => (path.endsWith(".wasm") && wasmUrl ? wasmUrl : prefix + path) };
    ready = prepareZXingModule({ overrides, fireImmediately: true });
  }
  return ready;
}

/**
 * @param {ImageData|{data:Uint8ClampedArray,width:number,height:number}} image
 * @returns {Promise<{text:string, points:number[][]}[]>}
 */
export async function readQR(image) {
  await ready;
  const results = await readBarcodes(image, {
    formats: ["QRCode"],
    tryHarder: true,
    tryRotate: false,
    tryInvert: false,
    maxNumberOfSymbols: 4,
  });
  return results
    .filter((r) => r.isValid && r.text)
    .map((r) => {
      const p = r.position;
      return { text: r.text, points: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map((q) => [q.x, q.y]) };
    });
}
