// 카메라 → Worker(zxing-wasm) 스캐너. UI 와는 이벤트로만 연결된다.
import { FrameGate } from "./gate.js";

export class ScanError extends Error {
  /** @param {"denied"|"nocamera"|"insecure"|"other"} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function classify(err) {
  const n = err && err.name;
  if (n === "NotAllowedError" || n === "SecurityError") return new ScanError("denied", "카메라 권한이 거부되었습니다.");
  if (n === "NotFoundError" || n === "OverconstrainedError" || n === "NotReadableError") {
    return new ScanError("nocamera", "사용할 수 있는 카메라를 찾지 못했습니다.");
  }
  return new ScanError("other", `카메라를 시작하지 못했습니다: ${err && err.message ? err.message : err}`);
}

export class Scanner extends EventTarget {
  /** @param {{workerUrl:URL, maxFps?:number, upscale?:number}} o */
  constructor({ workerUrl, maxFps = 10, upscale = 1 }) {
    super();
    this.workerUrl = workerUrl;
    this.upscale = upscale;
    this.gate = new FrameGate({ maxFps });
    this.stream = null;
    this.video = null;
    this.worker = null;
    this.opts = null;
    this.running = false;
    this.session = 0; // start()/stop() 마다 증가: 오래된 비동기 start 를 무효화
    this.loopGen = 0; // 프레임 루프 세대
    this.frameHandle = null;
    this.wakeLock = null;
    this._onVisible = () => {
      if (document.visibilityState !== "visible" || !this.running) return;
      this._acquireWakeLock();
      if (this._trackEnded()) {
        this.dispatchEvent(new CustomEvent("visibilityrestart"));
        this.start(this.video, this.opts).catch(() => {});
      } else if (this.video && this.video.paused) {
        this.video.play().catch(() => {});
      }
    };
  }

  _status(status, error) {
    this.dispatchEvent(new CustomEvent("status", { detail: { status, error } }));
  }

  _trackEnded() {
    const t = this.stream && this.stream.getVideoTracks()[0];
    return !t || t.readyState === "ended";
  }

  async _acquireWakeLock() {
    try {
      if (!this.wakeLock && navigator.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => (this.wakeLock = null));
      }
    } catch {
      this.wakeLock = null;
    }
  }

  /**
   * @param {HTMLVideoElement} video @param {{facingMode:"environment"|"user", width:number, scan?:boolean}} opts
   * @returns {Promise<boolean>} 시작되면 true, 더 새로운 start()/stop() 에 밀려 취소되면 false
   */
  async start(video, opts) {
    this.stop(true);
    const token = this.session;
    this.video = video;
    this.opts = opts;
    this._status("starting");
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const e = new ScanError("insecure", "카메라는 https:// 주소에서만 사용할 수 있습니다.");
      this._status("error", e);
      throw e;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: opts.facingMode }, width: { ideal: opts.width }, frameRate: { ideal: 30 } },
      });
    } catch (err) {
      if (token !== this.session) return false;
      const e = classify(err);
      this._status("error", e);
      throw e;
    }
    if (token !== this.session) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.stream = stream;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    try {
      await video.play();
    } catch (err) {
      if (token !== this.session) return false;
      this.stop(true);
      const e = classify(err);
      this._status("error", e);
      throw e;
    }
    if (token !== this.session) return false;
    this.running = true;
    document.addEventListener("visibilitychange", this._onVisible);
    this._acquireWakeLock();
    if (opts.scan !== false) {
      // scan:false 는 카메라 미리보기만 켠다 (녹화 전용 페이지)
      this._ensureWorker();
      this._status("scanning");
      this._loop();
    } else {
      this._status("preview");
    }
    return true;
  }

  _ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(this.workerUrl, { type: "module" });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "result") {
        this.gate.end(m.id);
        this.dispatchEvent(new CustomEvent("texts", { detail: { texts: m.texts, points: m.points, w: m.w, h: m.h } }));
      } else if (m.type === "error") {
        this.gate.end(m.id);
        this.dispatchEvent(new CustomEvent("workererror", { detail: m.message }));
      }
    };
    this.worker.postMessage({ type: "init" });
  }

  _loop() {
    const v = this.video;
    const gen = ++this.loopGen;
    const tick = async () => {
      if (!this.running || gen !== this.loopGen) return;
      if (v.readyState >= 2 && v.videoWidth && this.gate.tryBegin()) {
        const ticket = this.gate.ticket;
        try {
          const bitmap = await createImageBitmap(v);
          if (gen !== this.loopGen || !this.worker) {
            bitmap.close();
          } else {
            this.worker.postMessage({ type: "scan", id: ticket, bitmap, scale: this.upscale }, [bitmap]);
          }
        } catch {
          this.gate.end(ticket);
        }
      }
      if (this.running && gen === this.loopGen) {
        this.frameHandle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
      }
    };
    tick();
  }

  setOptions({ maxFps, upscale }) {
    if (maxFps !== undefined) this.gate.setMaxFps(maxFps);
    if (upscale !== undefined) this.upscale = upscale;
  }

  capabilities() {
    const t = this.stream && this.stream.getVideoTracks()[0];
    const c = t && t.getCapabilities ? t.getCapabilities() : {};
    return { zoom: c.zoom ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step || 0.1 } : undefined, torch: !!c.torch };
  }

  async applyTrack({ zoom, torch }) {
    const t = this.stream && this.stream.getVideoTracks()[0];
    if (!t) return;
    const adv = {};
    if (zoom !== undefined) adv.zoom = zoom;
    if (torch !== undefined) adv.torch = torch;
    await t.applyConstraints({ advanced: [adv] });
  }

  stop(keepWorker = false) {
    this.session++;
    this.loopGen++;
    this.running = false;
    document.removeEventListener("visibilitychange", this._onVisible);
    if (this.frameHandle !== null && this.video) {
      try {
        if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frameHandle);
        else cancelAnimationFrame(this.frameHandle);
      } catch {}
    }
    this.frameHandle = null;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
    this.gate.end();
    if (!keepWorker && this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
