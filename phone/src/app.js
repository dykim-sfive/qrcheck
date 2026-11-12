import { Scanner } from "./scanner.js";
import { Decoder } from "./decoder.js";
import { describe } from "./ui-model.js";
import { $, loadSettings, bindSetting, initZoomBar, drawQuads } from "./ui-shared.js";

const decoder = new Decoder();
const scanner = new Scanner({ workerUrl: new URL("./worker.js", import.meta.url) });

const { settings, save: saveSettings } = loadSettings("qr-settings", { facing: "environment", width: "1280", fps: "10", upscale: "1", corner: "top", zoom: "1" });
const zoomUi = initZoomBar({ scanner, settings, save: saveSettings });

const state = { scannerStatus: "idle", error: null, result: null };
let running = false;
let blobUrl = null;
let boxes = [];
let boxAt = 0;

function render() {
  const view = describe({ ...state, scannerStatus: state.scannerStatus === "idle" ? "scanning" : state.scannerStatus, decoder });
  if (state.scannerStatus === "idle") {
    view.phase = "starting";
    view.message = "시작 버튼을 눌러 카메라를 켜세요.";
  }
  const phaseNames = { starting: "대기", searching: "찾는 중", reading: "읽는 중", done: "완료", "crc-failed": "검증 실패", error: "오류" };
  $("phase").dataset.phase = view.phase;
  $("phase").textContent = phaseNames[view.phase];
  $("message").textContent = view.message;
  $("fill").style.width = view.percent + "%";
  $("bar").setAttribute("aria-valuenow", view.percent);
  $("pct").textContent = view.percent + "%";
  $("blocks").textContent = decoder.k ? `${decoder.rank} / ${decoder.k} 블록` : "—";
  $("sNew").textContent = decoder.stats.new + decoder.stats.redundant;
  $("sDup").textContent = decoder.stats.dup;
  $("sBad").textContent = decoder.stats.bad;
  $("sOther").textContent = decoder.stats.other;
  $("result").hidden = !view.canDownload;
  if (view.canDownload) {
    $("fileName").textContent = view.fileName;
    $("fileSize").textContent = `(${view.fileSize.toLocaleString()} 바이트)`;
  }
  $("startStop").textContent = running ? "정지" : "시작";
}

function drawBoxes() {
  drawQuads($("overlay"), $("video"), performance.now() - boxAt > 400 ? [] : boxes);
}

scanner.addEventListener("texts", (e) => {
  const { texts, points } = e.detail;
  if (state.scannerStatus === "error" && running) {
    state.scannerStatus = "scanning"; // 프레임이 다시 읽히면 일시적 오류는 해제
    state.error = null;
  }
  boxes = points;
  boxAt = performance.now();
  drawBoxes();
  for (const t of texts) decoder.addText(t);
  if (decoder.done) finish();
  render();
});
scanner.addEventListener("status", (e) => {
  state.scannerStatus = e.detail.status;
  state.error = e.detail.error || null;
  render();
});
// 프레임 하나를 읽다 난 오류는 치명적이지 않다: 세어 두기만 하고 계속 스캔한다
let workerErrors = 0;
scanner.addEventListener("workererror", () => {
  workerErrors++;
  if (workerErrors >= 20 && decoder.rank === 0) {
    state.scannerStatus = "error";
    state.error = { code: "other" };
    render();
  }
});

function finish() {
  state.result = decoder.result();
  stop();
}

async function start(force = false) {
  if (running && !force) return;
  if (decoder.done) resetTransfer(); // 완료된 뒤에 다시 시작하면 새 전송으로 본다
  running = true;
  state.error = null;
  workerErrors = 0;
  scanner.setOptions({ maxFps: Number(settings.fps), upscale: Number(settings.upscale) });
  render();
  try {
    const started = await scanner.start($("video"), { facingMode: settings.facing, width: Number(settings.width) });
    if (started) zoomUi.applyCaps();
  } catch {
    running = false;
  }
  render();
}

function stop() {
  running = false;
  scanner.stop();
  boxes = [];
  drawBoxes();
  render();
}

$("startStop").onclick = () => (running ? stop() : start());
function resetTransfer() {
  decoder.reset();
  state.result = null;
  state.error = null;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
}
$("reset").onclick = () => {
  resetTransfer();
  render();
  if (!running) start();
};
$("download").onclick = () => {
  if (!state.result) return;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  const view = describe({ scannerStatus: "scanning", error: null, decoder, result: state.result });
  blobUrl = URL.createObjectURL(new Blob([state.result], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = view.fileName;
  document.body.append(a);
  a.click();
  a.remove();
};
$("preview").onclick = () => $("preview").classList.toggle("big");

// 설정
const restartIfRunning = () => {
  if (running) start(true);
};
bindSetting(settings, saveSettings, "facing", "facing", restartIfRunning);
bindSetting(settings, saveSettings, "width", "width", restartIfRunning);
bindSetting(settings, saveSettings, "fps", "fps", () => scanner.setOptions({ maxFps: Number(settings.fps) }));
bindSetting(settings, saveSettings, "upscale", "upscale", () => scanner.setOptions({ upscale: Number(settings.upscale) }));
bindSetting(settings, saveSettings, "corner", "corner", () => (document.body.dataset.corner = settings.corner));
document.body.dataset.corner = settings.corner;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
