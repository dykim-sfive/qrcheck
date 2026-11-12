// 두 페이지(실시간 / 녹화→해독)가 함께 쓰는 설정 저장, 배율 버튼, 미리보기 코너 처리.
import { clampZoom } from "./ui-model.js";

export const $ = (id) => document.getElementById(id);

export function loadSettings(storageKey, defaults) {
  const settings = { ...defaults };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(storageKey) || "{}"));
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(settings));
    } catch {}
  };
  return { settings, save };
}

export function bindSetting(settings, save, id, key, after) {
  const el = $(id);
  el.value = settings[key];
  el.onchange = () => {
    settings[key] = el.value;
    save();
    after && after();
  };
}

/** 1×/1.5×/2× 버튼, 줌 슬라이더, 플래시. 카메라가 켜질 때마다 applyCaps() 를 부른다. */
export function initZoomBar({ scanner, settings, save }) {
  const buttons = [...$("zoombar").querySelectorAll("button")];
  const markZoom = (value) => buttons.forEach((b) => b.setAttribute("aria-pressed", String(Math.abs(Number(b.dataset.zoom) - value) < 0.05)));

  async function setZoom(wanted) {
    const z = clampZoom(scanner.capabilities(), wanted);
    if (z === null) return;
    try {
      await scanner.applyTrack({ zoom: z });
      settings.zoom = String(wanted);
      save();
      $("zoom").value = z;
      markZoom(wanted);
    } catch {}
  }

  function applyCaps() {
    const caps = scanner.capabilities();
    $("zoomRow").hidden = !caps.zoom;
    if (caps.zoom) {
      const z = $("zoom");
      z.min = caps.zoom.min;
      z.max = caps.zoom.max;
      z.step = caps.zoom.step;
      z.value = caps.zoom.min;
    }
    const supported = !!caps.zoom;
    for (const b of buttons) {
      b.disabled = !supported;
      b.title = supported ? "" : "이 카메라/브라우저는 줌 조절을 지원하지 않습니다";
    }
    $("torchRow").hidden = !caps.torch;
    $("torch").checked = false;
    if (supported) setZoom(Number(settings.zoom) || 1); // 카메라를 다시 켜도 선택한 배율 유지
  }

  $("zoom").oninput = () => {
    const v = Number($("zoom").value);
    scanner.applyTrack({ zoom: v }).then(() => markZoom(v)).catch(() => {});
  };
  buttons.forEach((b) => {
    b.disabled = true; // 카메라가 켜지기 전엔 비활성
    b.onclick = () => setZoom(Number(b.dataset.zoom));
  });
  $("torch").onchange = () => scanner.applyTrack({ torch: $("torch").checked }).catch(() => ($("torch").checked = false));
  markZoom(Number(settings.zoom) || 1);
  return { applyCaps };
}

/** 영상 위에 인식된 QR 테두리를 그린다 (object-fit: cover 기준 좌표 변환). */
export function drawQuads(cv, v, quads) {
  const r = cv.getBoundingClientRect();
  if (cv.width !== Math.round(r.width) || cv.height !== Math.round(r.height)) {
    cv.width = Math.round(r.width);
    cv.height = Math.round(r.height);
  }
  const g = cv.getContext("2d");
  g.clearRect(0, 0, cv.width, cv.height);
  if (!quads.length || !v.videoWidth) return;
  const s = Math.max(cv.width / v.videoWidth, cv.height / v.videoHeight);
  const ox = (cv.width - v.videoWidth * s) / 2;
  const oy = (cv.height - v.videoHeight * s) / 2;
  g.lineWidth = 3;
  g.strokeStyle = "#22c55e";
  for (const quad of quads) {
    g.beginPath();
    quad.forEach(([x, y], i) => (i ? g.lineTo(x * s + ox, y * s + oy) : g.moveTo(x * s + ox, y * s + oy)));
    g.closePath();
    g.stroke();
  }
}
