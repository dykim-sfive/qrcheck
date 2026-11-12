// QR 인식 Worker: {type:"init"} 후 {type:"scan", id, bitmap, scale} 를 받아 {type:"result", id, texts, points} 로 응답.
import { initZXing, readQR } from "./zxing-read.js";

let canvas = null;
let ctx = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") {
      await initZXing({ wasmUrl: new URL("../vendor/zxing-wasm/zxing_reader.wasm", import.meta.url).href });
      self.postMessage({ type: "ready" });
    } else if (m.type === "scan") {
      const srcW = m.bitmap.width;
      const srcH = m.bitmap.height;
      const w = Math.round(srcW * m.scale);
      const h = Math.round(srcH * m.scale);
      if (!canvas) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext("2d", { willReadFrequently: true });
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(m.bitmap, 0, 0, w, h);
      m.bitmap.close();
      const hits = await readQR(ctx.getImageData(0, 0, w, h));
      // 좌표는 원본 프레임 기준으로 되돌린다
      const points = hits.map((r) => r.points.map(([x, y]) => [x / m.scale, y / m.scale]));
      self.postMessage({ type: "result", id: m.id, texts: hits.map((r) => r.text), points, w: srcW, h: srcH });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, message: String(err && err.message ? err.message : err) });
  }
};
