// 녹화된 영상 파일을 느리게 재생하면서 프레임을 하나씩 읽어 Worker(zxing-wasm)로 QR 을 해독한다.
// 실시간 카메라와 달리 Worker 가 바쁘면 영상을 잠깐 멈추고 기다리므로 프레임을 건너뛰지 않는다.
export class FileScanner extends EventTarget {
  /** @param {{workerUrl:URL, rate?:number, upscale?:number}} o  rate: 재생 배속 (0.0625~1) */
  constructor({ workerUrl, rate = 0.5, upscale = 1 }) {
    super();
    this.workerUrl = workerUrl;
    this.rate = rate;
    this.upscale = upscale;
    this.video = null;
    this.worker = null;
    this.url = null;
    this.running = false;
    this.busy = false;
    this.parked = false; // 처리 중이라 영상을 멈춰 둔 상태
    this.resumeAfter = false;
    this.handle = null;
    this.gen = 0;
    this.ticket = 0;
    this.frames = 0;
  }

  /** @param {HTMLVideoElement} video @param {Blob} blob */
  async load(video, blob) {
    this.stop();
    this.video = video;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    video.srcObject = null;
    video.muted = true;
    video.playsInline = true;
    video.loop = false;
    video.src = this.url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("이 영상을 열 수 없습니다. mp4(H.264) 또는 webm 으로 다시 저장해 보세요."));
    });
    video.onerror = null;
    video.currentTime = 0;
  }

  _ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(this.workerUrl, { type: "module" });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "result" || m.type === "error") this._onResult(m);
    };
    this.worker.postMessage({ type: "init" });
  }

  setOptions({ rate, upscale }) {
    if (rate !== undefined) {
      this.rate = rate;
      if (this.video) this.video.playbackRate = rate;
    }
    if (upscale !== undefined) this.upscale = upscale;
  }

  /** 처음부터(또는 현재 위치부터) 재생하며 해독 시작. @param {{fromStart?:boolean}} o */
  async play({ fromStart = true } = {}) {
    const v = this.video;
    if (!v) return;
    this._ensureWorker();
    if (fromStart) v.currentTime = 0;
    this.running = true;
    this.busy = this.parked = this.resumeAfter = false;
    v.playbackRate = this.rate;
    v.onended = () => this._finish();
    await v.play();
    this._register();
  }

  _register() {
    const v = this.video;
    const gen = ++this.gen;
    const cb = () => this._tick(gen);
    this.handle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(cb) : requestAnimationFrame(cb);
  }

  _tick(gen) {
    if (!this.running || gen !== this.gen) return;
    if (this.busy) {
      this.video.pause(); // 처리 끝날 때까지 이 프레임에서 기다린다 (프레임을 건너뛰지 않기 위해)
      this.parked = true;
      return;
    }
    this._submit();
    this._register();
  }

  async _submit() {
    this.busy = true;
    const id = ++this.ticket;
    try {
      const bitmap = await createImageBitmap(this.video);
      this.worker.postMessage({ type: "scan", id, bitmap, scale: this.upscale }, [bitmap]);
    } catch {
      this._onResult({ type: "error", id });
    }
  }

  _onResult(m) {
    this.busy = false;
    if (m.type === "result") {
      this.frames++;
      this.dispatchEvent(new CustomEvent("texts", { detail: { texts: m.texts, points: m.points, w: m.w, h: m.h } }));
    } else {
      this.dispatchEvent(new CustomEvent("workererror", { detail: m.message }));
    }
    if (!this.running) return;
    const v = this.video;
    if (this.parked) {
      // 멈춰 있던 프레임을 아직 읽지 않았으니 먼저 읽고, 그 결과가 오면 재생을 이어 간다
      this.parked = false;
      this.resumeAfter = true;
      this._submit();
    } else if (this.resumeAfter) {
      this.resumeAfter = false;
      if (v.ended) this._finish();
      else {
        v.play().catch(() => {});
        this._register();
      }
    }
    this.dispatchEvent(new CustomEvent("progress", { detail: { time: v.currentTime, duration: v.duration } }));
  }

  _finish() {
    if (!this.running) return;
    this.running = false;
    this.gen++;
    const done = () => this.dispatchEvent(new CustomEvent("ended"));
    // 마지막 프레임 처리 결과까지 기다린다
    if (this.busy) {
      const wait = setInterval(() => {
        if (!this.busy) {
          clearInterval(wait);
          done();
        }
      }, 30);
    } else done();
  }

  pause() {
    this.running = false;
    this.gen++;
    if (this.video) this.video.pause();
  }

  stop() {
    this.running = false;
    this.gen++;
    if (this.video) {
      this.video.pause();
      this.video.onended = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.busy = this.parked = this.resumeAfter = false;
  }
}
