// 화면에 보여줄 값을 상태에서 계산하는 순수 함수 (DOM 없음).
const ERROR_MESSAGES = {
  denied: "카메라 권한이 거부되었습니다. 주소창의 자물쇠 → 권한에서 카메라를 허용한 뒤 다시 시도하세요.",
  nocamera: "사용할 수 있는 카메라를 찾지 못했습니다. 다른 앱이 카메라를 쓰고 있지 않은지 확인하세요.",
  insecure: "카메라는 https:// 주소에서만 사용할 수 있습니다.",
  other: "카메라를 시작하지 못했습니다. 페이지를 새로고침해 보세요.",
};

export function fileNameFor(bytes) {
  const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  return zip ? "qr-transfer.zip" : "qr-transfer.bin";
}

/**
 * @param {{scannerStatus:string, error:{code:string,message:string}|null,
 *          decoder:{k:number|null,rank:number,done:boolean,size:number|null,crcFailed:boolean,stats:object},
 *          result:Uint8Array|null}} s
 */
export function describe(s) {
  const d = s.decoder;
  const out = { phase: "searching", message: "", percent: 0, stats: d.stats, canDownload: false, fileName: null, fileSize: null };
  if (d.crcFailed) {
    out.phase = "crc-failed";
    out.percent = 100;
    out.message = "복원했지만 CRC 가 맞지 않습니다. 초기화한 뒤 처음부터 다시 받아 주세요.";
    return out;
  }
  if (d.done && s.result) {
    out.phase = "done";
    out.percent = 100;
    out.message = "완료! 아래 버튼으로 내려받으세요.";
    out.canDownload = true;
    out.fileName = fileNameFor(s.result);
    out.fileSize = s.result.length;
    return out;
  }
  if (s.scannerStatus === "error") {
    out.phase = "error";
    out.message = ERROR_MESSAGES[s.error && s.error.code] || ERROR_MESSAGES.other;
    return out;
  }
  if (s.scannerStatus === "starting") {
    out.phase = "starting";
    out.message = "카메라 시작 중…";
    return out;
  }
  if (d.k === null) {
    out.message = "QR 찾는 중… PC 화면의 QR 이 카메라에 보이도록 맞춰 주세요.";
    return out;
  }
  out.phase = "reading";
  out.percent = Math.floor((d.rank / d.k) * 100);
  out.message = `읽는 중 ${d.rank}/${d.k} 블록`;
  return out;
}

/** 원하는 줌 배율을 카메라가 지원하는 범위로 맞춘다. 줌을 지원하지 않으면 null. */
export function clampZoom(caps, wanted) {
  const z = caps && caps.zoom;
  if (!z) return null;
  return Math.min(z.max, Math.max(z.min, wanted));
}
