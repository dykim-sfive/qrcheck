// 녹화 → 파일 저장 → 파일 해독 페이지.
import { Scanner } from "./scanner.js";
import { FileScanner } from "./file-scanner.js";
import { Decoder } from "./decoder.js";
import { describeRecord, pickRecorderMime, extFor, formatTime } from "./record-model.js";
import { $, loadSettings, bindSetting, initZoomBar, drawQuads } from "./ui-shared.js";

const workerUrl = new URL("./worker.js", import.meta.url);
const camera = new Scanner({ workerUrl }); // scan:false 로 미리보기만 쓴다
const fileScanner = new FileScanner({ workerUrl });
const decoder = new Decoder();
const video = $("video");

const { settings, save } = loadSettings("qr-record-settings", {
  facing: "environment", width: "1920", bitrate: "8000000", rate: "0.5", upscale: "1", corner: "top", zoom: "1",
});
const zoomUi = initZoomBar({ scanner: camera, settings, save });

const mime = typeof MediaRecorder === "undefined" ? "" : pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
const state = { mode: "idle", elapsed: 0, recordedSize: 0, error: null, result: null };
let blob = null;
let recorder = null;
let chunks = [];
let tickTimer = null;
let startedAt = 0;
let cameraOn = false;
let boxes = [];
let boxAt = 0;
let blobUrl = null;
let playInfo = "";

function render() {
  const v = describeRecord({ ...state, canRecord: !!mime, decoder });
  const names = { idle: "대기", recording: "녹화 중", recorded: "녹화됨", searching: "찾는 중", reading: "읽는 중", incomplete: "부족", done: "완료", "crc-failed": "검증 실패", error: "오류" };
  $("phase").dataset.phase = v.phase;
  $("phase").textContent = names[v.phase];
  $("message").textContent = v.message;
  $("timeInfo").textContent = playInfo;
  $("fill").style.width = v.percent + "%";
  $("bar").setAttribute("aria-valuenow", v.percent);
  $("pct").textContent = v.percent + "%";
  $("blocks").textContent = decoder.k ? `${decoder.rank} / ${decoder.k} 블록` : "—";
  $("sNew").textContent = decoder.stats.new + decoder.stats.redundant;
  $("sDup").textContent = decoder.stats.dup;
  $("sBad").textContent = decoder.stats.bad;
  $("sOther").textContent = decoder.stats.other;
  $("result").hidden = !v.canDownload;
  if (v.canDownload) {
    $("fileName").textContent = v.fileName;
    $("fileSize").textContent = `(${v.fileSize.toLocaleString()} 바이트)`;
  }
  const rec = state.mode === "recording";
  $("rec").textContent = rec ? "■ 녹화 정지" : "● 녹화 시작";
  $("rec").disabled = rec ? false : !v.canRecord;
  $("cam").textContent = cameraOn ? "카메라 끄기" : "카메라 켜기";
  $("cam").disabled = rec || state.mode === "decoding";
  $("save").disabled = !v.canSave;
  $("pick").disabled = rec || state.mode === "decoding";
  $("decode").disabled = !v.canDecode;
  $("decode").textContent = state.mode === "ended" ? "다시 해독" : "해독 시작";
}

function setError(code) {
  state.mode = "error";
  state.error = { code };
  render();
}

// ---- 카메라 / 녹화 ----
async function cameraStart() {
  try {
    const ok = await camera.start(video, { facingMode: settings.facing, width: Number(settings.width), scan: false });
    if (ok) {
      cameraOn = true;
      zoomUi.applyCaps();
    }
  } catch (e) {
    cameraOn = false;
    setError(e.code || "other");
    return false;
  }
  if (state.mode === "error") state.mode = blob ? "recorded" : "idle";
  render();
  return cameraOn;
}

function cameraStop() {
  camera.stop();
  cameraOn = false;
  render();
}

async function startRecording() {
  if (!mime) return;
  fileScanner.stop();
  if (!cameraOn && !(await cameraStart())) return;
  resetTransfer();
  chunks = [];
  try {
    recorder = new MediaRecorder(camera.stream, { mimeType: mime, videoBitsPerSecond: Number(settings.bitrate) });
  } catch {
    setError("other");
    return;
  }
  recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  recorder.onerror = () => setError("other");
  recorder.onstop = onRecorded;
  recorder.start(1000);
  startedAt = performance.now();
  state.mode = "recording";
  state.elapsed = 0;
  tickTimer = setInterval(() => {
    state.elapsed = (performance.now() - startedAt) / 1000;
    render();
  }, 250);
  render();
}

async function onRecorded() {
  clearInterval(tickTimer);
  state.elapsed = (performance.now() - startedAt) / 1000;
  cameraStop(); // 녹화가 끝나면 카메라를 끄고 파일을 미리보기로 불러온다
  await useBlob(new Blob(chunks, { type: mime }));
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

async function useBlob(b) {
  blob = b;
  state.recordedSize = b.size;
  state.error = null;
  try {
    await fileScanner.load(video, b);
    state.mode = "recorded";
    playInfo = `영상 길이 ${formatTime(video.duration)}`;
  } catch (e) {
    state.mode = "error";
    state.error = { code: "other" };
    $("message").textContent = e.message;
  }
  render();
  if (state.mode === "error") $("message").textContent = "이 영상을 열 수 없습니다. mp4(H.264) 또는 webm 으로 다시 저장해 보세요.";
}

function resetTransfer() {
  decoder.reset();
  state.result = null;
  state.error = null;
  playInfo = "";
  boxes = [];
  drawQuads($("overlay"), video, []);
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
}

// ---- 저장 / 파일 선택 ----
function download(b, name) {
  const url = URL.createObjectURL(b);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$("save").onclick = () => {
  if (!blob) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  download(blob, `qr-recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${extFor(blob.type || mime)}`);
};
$("pick").onclick = () => $("file").click();
$("file").onchange = async () => {
  const f = $("file").files[0];
  $("file").value = "";
  if (!f) return;
  fileScanner.stop();
  cameraStop();
  resetTransfer();
  await useBlob(f);
};

// ---- 해독 ----
fileScanner.addEventListener("texts", (e) => {
  boxes = e.detail.points;
  boxAt = performance.now();
  drawQuads($("overlay"), video, boxes);
  for (const t of e.detail.texts) decoder.addText(t);
  if (decoder.done) finishDecode();
  render();
});
fileScanner.addEventListener("progress", (e) => {
  playInfo = `재생 ${formatTime(e.detail.time)} / ${formatTime(e.detail.duration)} · 읽은 프레임 ${fileScanner.frames}`;
  render();
});
fileScanner.addEventListener("ended", () => {
  if (state.mode === "decoding") {
    state.mode = "ended";
    drawQuads($("overlay"), video, []);
    render();
  }
});
fileScanner.addEventListener("workererror", () => {
  /* 프레임 하나의 오류는 건너뛴다 */
});

function finishDecode() {
  state.result = decoder.result();
  fileScanner.pause();
  state.mode = "ended";
  drawQuads($("overlay"), video, []);
}

$("decode").onclick = async () => {
  if (!blob) return;
  // 같은 영상을 다시 읽을 때는 지금까지 모은 블록을 유지한다 (설정을 바꿔 부족분을 채울 수 있게)
  fileScanner.setOptions({ rate: Number(settings.rate), upscale: Number(settings.upscale) });
  state.mode = "decoding";
  render();
  try {
    await fileScanner.play({ fromStart: true });
  } catch {
    state.mode = "error";
    state.error = { code: "other" };
    render();
  }
};

$("cam").onclick = () => (cameraOn ? cameraStop() : cameraStart());
$("rec").onclick = () => (state.mode === "recording" ? stopRecording() : startRecording());
$("reset").onclick = () => {
  stopRecording();
  fileScanner.stop();
  cameraStop();
  clearInterval(tickTimer);
  resetTransfer();
  blob = null;
  chunks = [];
  state.mode = "idle";
  state.recordedSize = 0;
  state.elapsed = 0;
  video.removeAttribute("src");
  video.load();
  render();
};
$("download").onclick = () => {
  if (!state.result) return;
  const view = describeRecord({ ...state, mode: "ended", canRecord: true, decoder });
  download(new Blob([state.result], { type: "application/octet-stream" }), view.fileName);
};
$("preview").onclick = () => $("preview").classList.toggle("big");

bindSetting(settings, save, "facing", "facing", () => cameraOn && state.mode !== "recording" && cameraStart());
bindSetting(settings, save, "width", "width", () => cameraOn && state.mode !== "recording" && cameraStart());
bindSetting(settings, save, "bitrate", "bitrate");
bindSetting(settings, save, "rate", "rate", () => fileScanner.setOptions({ rate: Number(settings.rate) }));
bindSetting(settings, save, "upscale", "upscale", () => fileScanner.setOptions({ upscale: Number(settings.upscale) }));
bindSetting(settings, save, "corner", "corner", () => (document.body.dataset.corner = settings.corner));
document.body.dataset.corner = settings.corner;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
