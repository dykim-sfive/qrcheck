// 카메라 프레임 → Worker 전달 속도 제어: 처리 중에는 새 프레임을 보내지 않고(backpressure), maxFps 간격을 지킨다.
export class FrameGate {
  /** @param {{maxFps:number, now?:()=>number, timeoutMs?:number}} o  maxFps 0 = 제한 없음 */
  constructor({ maxFps = 0, now = () => performance.now(), timeoutMs = 3000 } = {}) {
    this.maxFps = maxFps;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.busySince = null;
    this.lastStart = -Infinity;
    this.ticket = 0; // 현재 처리 중인 프레임 번호
  }

  setMaxFps(v) {
    this.maxFps = v;
  }

  tryBegin() {
    const t = this.now();
    if (this.busySince !== null) {
      if (t - this.busySince <= this.timeoutMs) return false;
      this.busySince = null; // 멈춘 프레임은 포기
    }
    if (this.maxFps > 0 && t - this.lastStart < 1000 / this.maxFps) return false;
    this.busySince = t;
    this.lastStart = t;
    this.ticket++;
    return true;
  }

  /** ticket 을 주면 현재 프레임의 결과일 때만 해제한다 (늦게 온 옛 결과가 새 프레임 자리를 풀지 않게). */
  end(ticket) {
    if (ticket !== undefined && ticket !== this.ticket) return;
    this.busySince = null;
  }
}
