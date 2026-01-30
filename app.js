// =======================
// CONFIG (IMPORTANT)
// =======================
// Replace this with your REAL space subdomain.
// It usually looks like: https://<username>-<space-name>.hf.space
const HF_SPACE_BASE_URL = "https://elgatito1-food-classifier.hf.space"; // <-- change if needed

const API_PREDICT_PATH = "/predict";

// =======================
// HELPERS
// =======================
function apiUrl(topK = 3) {
  const base = HF_SPACE_BASE_URL.replace(/\/$/, "");
  return `${base}${API_PREDICT_PATH}?top_k=${encodeURIComponent(topK)}`;
}

async function sendFrameToApi(blob, topK = 3) {
  const form = new FormData();

  // Your FastAPI expects the field name: `file`
  form.append("file", blob, "frame.jpg");

  const res = await fetch(apiUrl(topK), {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  return res.json();
}

// =======================
// CAMERA CAPTURE
// =======================
const videoEl = document.getElementById("video");
const canvasEl = document.getElementById("canvas");
const resultEl = document.getElementById("result");

let stream = null;
let timer = null;
let inFlight = false;

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  videoEl.srcObject = stream;
  await videoEl.play();
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

function captureFrameToBlob() {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) return Promise.resolve(null);

  canvasEl.width = w;
  canvasEl.height = h;

  const ctx = canvasEl.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, w, h);

  return new Promise((resolve) => {
    canvasEl.toBlob((b) => resolve(b), "image/jpeg", 0.9);
  });
}

// =======================
// LOOP
// =======================
async function captureOnce(topK = 3) {
  if (inFlight) return;
  inFlight = true;

  try {
    const blob = await captureFrameToBlob();
    if (!blob) return;

    const data = await sendFrameToApi(blob, topK);
    renderResult(data);
  } catch (err) {
    console.error(err);
    resultEl.textContent = String(err.message || err);
  } finally {
    inFlight = false;
  }
}

function startMonitoringLoop(intervalMs = 1500, topK = 3) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => captureOnce(topK), intervalMs);
}

function stopMonitoringLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// =======================
// UI
// =======================
function renderResult(data) {
  // Expected shape from your API:
  // { predicted_label, confidence, top_k: [{label, confidence}, ...] }
  const lines = [];

  if (data?.predicted_label) {
    lines.push(`Predicted: ${data.predicted_label} (${(data.confidence * 100).toFixed(1)}%)`);
  }

  if (Array.isArray(data?.top_k)) {
    lines.push("");
    lines.push("Top K:");
    for (const item of data.top_k) {
      lines.push(`- ${item.label}: ${(item.confidence * 100).toFixed(1)}%`);
    }
  }

  resultEl.textContent = lines.join("\n");
}

// =======================
// BOOT
// =======================
(async function boot() {
  await startCamera();
  startMonitoringLoop(1500, 3);
})();
