/* ========= CONFIG (defaults) ========= */
const SETTINGS_KEY = "fridgecam_settings_v1";

const defaultSettings = {
  apiBaseUrl: "https://YOUR-SPACE.hf.space", // <-- change this
  fps: 1,
  sendSize: 320,
  windowFrames: 60
};

let settings = loadSettings();

/* ========= UI refs ========= */
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const btnClear = document.getElementById("btnClear");

const pillStatus = document.getElementById("pillStatus");
const apiState = document.getElementById("apiState");
const framesCount = document.getElementById("framesCount");
const progressBar = document.getElementById("progressBar");
const hintText = document.getElementById("hintText");

const liveLabel = document.getElementById("liveLabel");
const liveConf = document.getElementById("liveConf");
const liveMajority = document.getElementById("liveMajority");
const minuteIndexEl = document.getElementById("minuteIndex");
const pillLive = document.getElementById("pillLive");
const topChips = document.getElementById("topChips");

const historyList = document.getElementById("historyList");

/* Settings sheet */
const btnSettings = document.getElementById("btnSettings");
const sheet = document.getElementById("sheet");
const sheetBackdrop = document.getElementById("sheetBackdrop");
const btnSave = document.getElementById("btnSave");
const btnClose = document.getElementById("btnClose");

const apiUrlInput = document.getElementById("apiUrl");
const fpsInput = document.getElementById("fps");
const sendSizeInput = document.getElementById("sendSize");
const windowFramesInput = document.getElementById("windowFrames");

/* ========= State ========= */
let stream = null;
let running = false;

let captureTimer = null;
let framesInWindow = []; // { label, className, conf }
let minuteCounter = 0;

/* ========= Helpers ========= */
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw);
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(next) {
  settings = next;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function setStatus(text, tone = "idle") {
  pillStatus.textContent = text;
  // tiny tone changes with emoji for clarity
  if (tone === "good") pillStatus.textContent = `✅ ${text}`;
  if (tone === "warn") pillStatus.textContent = `⚠️ ${text}`;
  if (tone === "bad") pillStatus.textContent = `⛔ ${text}`;
}

function setApiState(text) {
  apiState.textContent = text;
}

function fmtPct(x) {
  if (x == null || Number.isNaN(x)) return "—";
  return `${Math.round(x * 100)}%`;
}

function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clearHistoryUI() {
  historyList.innerHTML = `<div class="empty">No results yet.</div>`;
}

function addHistoryItem({ when, label, conf, majority, top3 }) {
  if (historyList.querySelector(".empty")) historyList.innerHTML = "";

  const div = document.createElement("div");
  div.className = "item";

  const left = document.createElement("div");
  left.className = "item-left";
  left.innerHTML = `<div class="when">${when}</div><div class="what">${label}</div>`;

  const right = document.createElement("div");
  right.className = "item-right";
  right.innerHTML = `<div class="conf">${fmtPct(conf)}</div><div class="maj">Maj: ${majority}</div>`;

  div.appendChild(left);
  div.appendChild(right);

  // Optional: store details as a tooltip
  if (top3 && top3.length) {
    div.title = top3.map(t => `${t.label} (${fmtPct(t.prob)})`).join(" | ");
  }

  historyList.prepend(div);
}

function majorityVote(arr) {
  // vote by label string
  const counts = new Map();
  for (const x of arr) {
    const key = x.label || x.className || "Unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = "—";
  let bestCount = 0;
  for (const [k, c] of counts.entries()) {
    if (c > bestCount) {
      bestKey = k;
      bestCount = c;
    }
  }
  return { label: bestKey, count: bestCount };
}

function setLiveUI({ label, conf, majorityCount, top3 }) {
  liveLabel.textContent = label || "—";
  liveConf.textContent = conf == null ? "—" : fmtPct(conf);
  liveMajority.textContent = majorityCount != null ? `${majorityCount}/${settings.windowFrames}` : "—";
  minuteIndexEl.textContent = String(minuteCounter);

  pillLive.textContent = "LIVE";
  pillLive.classList.remove("subtle");

  topChips.innerHTML = "";
  if (top3 && top3.length) {
    for (const t of top3.slice(0, 3)) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = `${t.label} · ${fmtPct(t.prob)}`;
      topChips.appendChild(chip);
    }
  }
}

function setWaitingLiveUI() {
  pillLive.textContent = "Waiting…";
  pillLive.classList.add("subtle");
  liveLabel.textContent = "—";
  liveConf.textContent = "—";
  liveMajority.textContent = "—";
  topChips.innerHTML = "";
}

/* ========= Camera ========= */
async function startCamera() {
  // Rear camera preferred
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: "environment" }
    }
  };

  stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;

  await new Promise((res) => {
    video.onloadedmetadata = () => res();
  });

  // set canvas based on sendSize
  canvas.width = settings.sendSize;
  canvas.height = Math.round(settings.sendSize * (video.videoHeight / video.videoWidth));
}

function stopCamera() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
}

/* ========= API call ========= */
async function sendFrameToApi(blob) {
  const url = `${settings.apiBaseUrl.replace(/\/$/, "")}/predict?top_k=3`;

  const form = new FormData();
  form.append("file", blob, "frame.jpg");

  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", body: form });
  const dt = Math.round(performance.now() - t0);

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${msg || "Request failed"}`);
  }
  const data = await res.json();
  setApiState(`OK • ${dt}ms`);
  return data;
}

/* ========= Capture loop ========= */
async function captureOnce() {
  if (!running || !stream) return;

  // Draw a downscaled frame for speed
  const targetW = settings.sendSize;
  const targetH = Math.round(targetW * (video.videoHeight / video.videoWidth));

  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.drawImage(video, 0, 0, targetW, targetH);

  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.6);
  });

  if (!blob) throw new Error("Failed to encode frame");

  const data = await sendFrameToApi(blob);

  // data expected from your FastAPI code:
  // { predicted_label, confidence, top_k: [{label, prob, class}] ... }
  const entry = {
    label: data.predicted_label || data.predicted_class || "Unknown",
    className: data.predicted_class || "",
    conf: typeof data.confidence === "number" ? data.confidence : null,
    top3: Array.isArray(data.top_k) ? data.top_k : []
  };

  framesInWindow.push(entry);
  framesCount.textContent = String(framesInWindow.length);

  // progress bar
  const pct = clamp(framesInWindow.length / settings.windowFrames, 0, 1);
  progressBar.style.width = `${Math.round(pct * 100)}%`;

  // after 60 frames -> majority vote -> publish LIVE result once
  if (framesInWindow.length >= settings.windowFrames) {
    minuteCounter += 1;

    const { label: voted, count } = majorityVote(framesInWindow);

    // confidence shown = average confidence among frames that matched the winning label
    const winners = framesInWindow.filter(x => x.label === voted && x.conf != null);
    const avgConf = winners.length ? winners.reduce((a, b) => a + b.conf, 0) / winners.length : null;

    // top3 chips from the last frame (looks “live”)
    const lastTop3 = framesInWindow[framesInWindow.length - 1]?.top3 || [];

    setLiveUI({
      label: voted,
      conf: avgConf,
      majorityCount: count,
      top3: lastTop3
    });

    addHistoryItem({
      when: `${nowTime()} • minute ${minuteCounter}`,
      label: voted,
      conf: avgConf,
      majority: `${count}/${settings.windowFrames}`,
      top3: lastTop3
    });

    // reset window
    framesInWindow = [];
    framesCount.textContent = "0";
    progressBar.style.width = "0%";
  }
}

function startMonitoringLoop() {
  const intervalMs = Math.round(1000 / clamp(settings.fps, 1, 2));
  hintText.textContent = "Monitoring… capturing frames and updating once per minute";
  setStatus("Running", "good");

  captureTimer = setInterval(async () => {
    try {
      await captureOnce();
    } catch (err) {
      console.error(err);
      setApiState("Error");
      setStatus("API error", "warn");
      hintText.textContent = "API error. Check URL / CORS / your Space is running.";
    }
  }, intervalMs);
}

function stopMonitoringLoop() {
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
}

/* ========= UI wiring ========= */
btnStart.addEventListener("click", async () => {
  try {
    btnStart.disabled = true;
    setStatus("Starting…");

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("No camera support", "bad");
      hintText.textContent = "This browser does not support camera capture.";
      btnStart.disabled = false;
      return;
    }

    await startCamera();

    running = true;
    btnStop.disabled = false;

    setWaitingLiveUI();
    framesInWindow = [];
    framesCount.textContent = "0";
    progressBar.style.width = "0%";
    setApiState("Connecting…");

    startMonitoringLoop();
  } catch (err) {
    console.error(err);
    setStatus("Camera blocked", "bad");
    hintText.textContent = "Camera permission denied or unavailable. Try HTTPS + allow permissions.";
    btnStart.disabled = false;
  }
});

btnStop.addEventListener("click", () => {
  running = false;
  stopMonitoringLoop();
  stopCamera();

  btnStop.disabled = true;
  btnStart.disabled = false;

  setStatus("Stopped");
  setApiState("Not connected");
  hintText.textContent = "Stopped. Tap Start to monitor again.";

  framesInWindow = [];
  framesCount.textContent = "0";
  progressBar.style.width = "0%";
});

btnClear.addEventListener("click", () => {
  clearHistoryUI();
  minuteCounter = 0;
  minuteIndexEl.textContent = "0";
  setWaitingLiveUI();
});

/* Settings */
function openSheet() {
  apiUrlInput.value = settings.apiBaseUrl;
  fpsInput.value = String(settings.fps);
  sendSizeInput.value = String(settings.sendSize);
  windowFramesInput.value = String(settings.windowFrames);

  sheet.classList.remove("hidden");
  sheetBackdrop.classList.remove("hidden");
}

function closeSheet() {
  sheet.classList.add("hidden");
  sheetBackdrop.classList.add("hidden");
}

btnSettings.addEventListener("click", openSheet);
btnClose.addEventListener("click", closeSheet);
sheetBackdrop.addEventListener("click", closeSheet);

btnSave.addEventListener("click", () => {
  const apiBaseUrl = (apiUrlInput.value || "").trim() || defaultSettings.apiBaseUrl;
  const fps = clamp(parseInt(fpsInput.value || "1", 10), 1, 2);
  const sendSize = clamp(parseInt(sendSizeInput.value || "320", 10), 160, 640);
  const windowFrames = clamp(parseInt(windowFramesInput.value || "60", 10), 30, 120);

  saveSettings({ apiBaseUrl, fps, sendSize, windowFrames });

  // update canvas size if needed
  canvas.width = settings.sendSize;

  closeSheet();
});

/* Init */
(function init() {
  setStatus("Idle");
  setApiState("Not connected");
  clearHistoryUI();
  setWaitingLiveUI();

  // nice default hint:
  hintText.textContent = "Tap Start, allow camera, then keep the fridge view steady.";
})();
