// 녹화 → 파일 해독 페이지의 화면 상태 계산 (DOM 없음).
import { describe } from "./ui-model.js";

const MIME_CANDIDATES = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];

/** MediaRecorder 가 지원하는 첫 형식. 없으면 "". @param {(mime:string)=>boolean} isSupported */
export function pickRecorderMime(isSupported) {
  return MIME_CANDIDATES.find((m) => isSupported(m)) || "";
}

export function extFor(mime) {
  return /mp4/.test(mime) ? "mp4" : "webm";
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "--:--";
  const s = Math.floor(sec);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

/**
 * @param {{mode:"idle"|"recording"|"recorded"|"decoding"|"ended"|"error", elapsed:number, recordedSize:number,
 *          canRecord:boolean, decoder:object, result:Uint8Array|null, error:{code:string}|null}} s
 */
export function describeRecord(s) {
  const has = s.recordedSize > 0;
  const base = describe({ scannerStatus: s.mode === "error" ? "error" : "scanning", error: s.error, decoder: s.decoder, result: s.result });
  const out = {
    phase: "idle", message: "", percent: base.percent, stats: s.decoder.stats,
    canRecord: s.canRecord && s.mode !== "recording" && s.mode !== "decoding",
    canStop: s.mode === "recording",
    canSave: has && s.mode !== "recording",
    canDecode: has && (s.mode === "recorded" || s.mode === "ended"),
    canDownload: false, fileName: null, fileSize: null,
  };
  if (base.phase === "done" || base.phase === "crc-failed") {
    return { ...out, phase: base.phase, message: base.message, canDownload: base.canDownload, fileName: base.fileName, fileSize: base.fileSize, percent: 100 };
  }
  if (s.mode === "error") return { ...out, phase: "error", message: base.message };
  switch (s.mode) {
    case "recording":
      out.phase = "recording";
      out.message = `녹화 중 ${formatTime(s.elapsed)} — PC 화면의 QR 재생을 2바퀴 이상 찍은 뒤 정지를 누르세요.`;
      break;
    case "recorded":
      out.phase = "recorded";
      out.message = `녹화 파일 ${mb(s.recordedSize)} 준비됨 — 「영상 저장」으로 보관하고 「해독 시작」을 누르세요.`;
      break;
    case "decoding":
      if (s.decoder.k === null) {
        out.phase = "searching";
        out.message = "녹화 파일에서 QR 찾는 중…";
      } else {
        out.phase = "reading";
        out.message = `읽는 중 ${s.decoder.rank}/${s.decoder.k} 블록`;
      }
      break;
    case "ended":
      out.phase = "incomplete";
      out.message = s.decoder.k === null
        ? "영상을 끝까지 읽었지만 QR 을 찾지 못했습니다. QR 이 크게 보이게 다시 녹화하거나 인식 확대를 올려 보세요."
        : `영상을 끝까지 읽었지만 ${s.decoder.rank}/${s.decoder.k} 블록뿐입니다. 더 길게(2바퀴 이상) 다시 녹화하거나, 설정을 바꿔 「해독 시작」으로 한 번 더 읽어 보세요.`;
      break;
    default:
      out.phase = "idle";
      out.message = s.canRecord ? "「녹화 시작」으로 PC 화면의 QR 재생을 촬영하세요. 또는 「파일 선택」으로 이미 찍은 영상을 고르세요." : "이 브라우저는 녹화를 지원하지 않습니다. 「파일 선택」으로 폰 카메라 앱으로 찍은 영상을 고르세요.";
  }
  return out;
}
