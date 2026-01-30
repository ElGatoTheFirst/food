/* ========= REQUIRED BY YOU ========= */
window.API_BASE = "https://elgatito1-food-classifier.hf.space";
/* =================================== */

(() => {
  "use strict";

  // -------- Settings --------
  const TOP_K = 3;
  const FPS = 1;
  const CAPTURE_INTERVAL_MS = Math.floor(1000 / FPS);
  const VOTE_WINDOW_MS = 60_000;
  const API_TIMEOUT_MS = 12_000;

  // -------- DOM (safe) --------
  function mustGet(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id} in index.html`);
    return el;
  }

  const els = {
    statusDot: null,
    statusText: null,
    fpsBadge: null,
    overlayText: null,
    startBtn: null,
    stopBtn: null,
    switchBtn: null,
    video: null,
    canvas: null,
    errorBox: null,

    currentLabel: null,
    currentConf: null,
    topKList: null,

    minuteVerdictValue: null,
    minuteVerdictMeta: null,

    apiBaseText: null,
  };

  // -------- State --------
  let stream = null;
  let facingMode = "environment"; // default back camera on phones
  let running = false;
  let loopTimer = null;
  let inFlight = false;

  // Minute voting state
  let voteStartMs = null;
  let voteCounts = Object.create(null);
  let voteConfSum = Object.create(null);
  let voteTotal = 0;

  // -------- Helpers --------
  function setStatus(kind, text) {
    els.statusText.textContent = text;

    els.statusDot.classList.remove("good", "bad", "warn");
    if (kind === "good") els.statusDot.classList.add("good");
    if (kind === "bad") els.statusDot.classList.add("bad");
    if (kind === "warn") els.statusDot.classList.add("warn");
  }

  function showError(msg) {
    els.errorBox.textContent = msg;
    els.errorBox.classList.remove("hidden");
  }

  function clearError() {
    els.errorBox.textContent = "";
    els.errorBox.classList.add("hidden");
  }

  function formatPct(x) {
    if (typeof x !== "number" || Number.isNaN(x)) return "—";
    return `${(x * 100).toFixed(1)}%`;
  }

  function clampCanvasSize(srcW, srcH, maxSide = 420) {
    const maxSrc = Math.max(srcW, srcH);
    if (maxSrc <= maxSide) return { w: srcW, h: srcH };

    const scale = maxSide / maxSrc;
    return {
      w: Math.round(srcW * scale),
      h: Math.round(srcH * scale),
    };
  }

  // -------- Minute Voting --------
  function resetVoteWindow(now = Date.now()) {
    voteStartMs = now;
    voteCounts = Object.create(null);
    voteConfSum = Object.create(null);
    voteTotal = 0;

    els.minuteVerdictValue.textContent = "-";
    els.minuteVerdictMeta.textContent = "Collecting… 0 frames (60s left)";
  }

  function updateVoteProgress() {
    if (voteStartMs === null) return;
    const elapsed = Date.now() - voteStartMs;
    const leftSec = Math.max(0, Math.ceil((VOTE_WINDOW_MS - elapsed) / 1000));
    els.minuteVerdictMeta.textContent = `Collecting… ${voteTotal} frames (${leftSec}s left)`;
  }

  function recordVote(label, confidence) {
    if (!label) return;

    if (voteStartMs === null) resetVoteWindow(Date.now());

    voteCounts[label] = (voteCounts[label] || 0) + 1;
    voteConfSum[label] = (voteConfSum[label] || 0) + (Number(confidence) || 0);
    voteTotal++;

    updateVoteProgress();
  }

  function finalizeVoteWindow() {
    if (voteStartMs === null) return;

    if (voteTotal === 0) {
      els.minuteVerdictValue.textContent = "-";
      els.minuteVerdictMeta.textContent = "No successful frames in the last minute.";
      resetVoteWindow(Date.now());
      return;
    }

    let bestLabel = null;
    let bestCount = -1;

    for (const [label, count] of Object.entries(voteCounts)) {
      if (count > bestCount) {
        bestCount = count;
        bestLabel = label;
      }
    }

    const pct = Math.round((bestCount / voteTotal) * 100);
    const avgConf = (voteConfSum[bestLabel] || 0) / bestCount;

    els.minuteVerdictValue.textContent = bestLabel;
    els.minuteVerdictMeta.textContent =
      `${bestCount}/${voteTotal} frames • ${pct}% • avg conf ${(avgConf || 0).toFixed(3)}`;

    // start next minute window immediately
    resetVoteWindow(Date.now());
  }

  // Safety timer: finalize even if frames are missed
  setInterval(() => {
    if (voteStartMs === null) return;
    const elapsed = Date.now() - voteStartMs;
    if (elapsed >= VOTE_WINDOW_MS) finalizeVoteWindow();
  }, 500);

  // -------- Camera --------
  async function stopCamera() {
    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }
    els.video.srcObject = null;
  }

  async function startCamera() {
    await stopCamera();

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    els.video.srcObject = stream;

    // Wait until video has dimensions
    await new Promise((resolve) => {
      if (els.video.readyState >= 2) return resolve();
      els.video.onloadedmetadata = () => resolve();
    });
  }

  async function switchCamera() {
    facingMode = (facingMode === "environment") ? "user" : "environment";

    if (!running) {
      // if not running, just restart camera preview
      try {
        setStatus("warn", "Switching camera…");
        await startCamera();
        setStatus("good", "Ready");
      } catch (e) {
        setStatus("bad", "Camera error");
        showError(String(e?.message || e));
      }
      return;
    }

    // if running, pause loop briefly, restart camera, then continue
    try {
      setStatus("warn", "Switching camera…");
      await startCamera();
      setStatus("good", "Monitoring");
      els.overlayText.textContent = "Monitoring…";
    } catch (e) {
      setStatus("bad", "Camera error");
      showError(String(e?.message || e));
    }
  }

  // -------- API --------
  async function sendFrameToApi(blob) {
    const url = `${window.API_BASE}/predict?top_k=${TOP_K}`;
    const fd = new FormData();
    fd.append("file", blob, "frame.jpg");

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        body: fd,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${text.slice(0, 140)}`);
      }

      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  // -------- UI Rendering --------
  function renderResult(data) {
    const label = data?.predicted_label ?? "—";
    const conf = data?.confidence;

    els.currentLabel.textContent = label;
    els.currentConf.textContent = formatPct(conf);

    const topK = Array.isArray(data?.top_k) ? data.top_k : [];
    els.topKList.innerHTML = "";

    if (topK.length === 0) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No top-k returned.";
      els.topKList.appendChild(li);
      return;
    }

    for (const item of topK.slice(0, TOP_K)) {
      const li = document.createElement("li");

      const left = document.createElement("div");
      left.className = "k-left";

      const title = document.createElement("div");
      title.className = "k-title";
      title.textContent = item?.label ?? item?.class ?? "Unknown";

      const sub = document.createElement("div");
      sub.className = "k-sub";
      sub.textContent = item?.class ? `class: ${item.class}` : " ";

      left.appendChild(title);
      left.appendChild(sub);

      const prob = document.createElement("div");
      prob.className = "k-prob";
      prob.textContent = formatPct(item?.prob);

      li.appendChild(left);
      li.appendChild(prob);

      els.topKList.appendChild(li);
    }
  }

  // -------- Capture Loop (1 FPS, no overlap) --------
  async function captureOnce() {
    if (!running) return;
    if (inFlight) return;

    // Ensure video has size
    const vw = els.video.videoWidth;
    const vh = els.video.videoHeight;
    if (!vw || !vh) return;

    inFlight = true;

    try {
      const { w, h } = clampCanvasSize(vw, vh, 420);
      els.canvas.width = w;
      els.canvas.height = h;

      const ctx = els.canvas.getContext("2d", { alpha: false });
      ctx.drawImage(els.video, 0, 0, w, h);

      const blob = await new Promise((resolve) => {
        els.canvas.toBlob(
          (b) => resolve(b),
          "image/jpeg",
          0.85
        );
      });

      if (!blob) throw new Error("Failed to encode frame (blob is null)");

      const data = await sendFrameToApi(blob);

      clearError();
      setStatus("good", "Monitoring");
      els.overlayText.textContent = "Monitoring…";

      renderResult(data);
      recordVote(data?.predicted_label, data?.confidence);
    } catch (e) {
      // Don’t crash, just show error and keep trying next second
      setStatus("warn", "API issue");
      els.overlayText.textContent = "Trying…";
      showError(String(e?.message || e));
    } finally {
      inFlight = false;
    }
  }

  function startLoop() {
    // run immediately, then every 1s (but captureOnce blocks overlap)
    captureOnce();
    loopTimer = setInterval(captureOnce, CAPTURE_INTERVAL_MS);
  }

  function stopLoop() {
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = null;
    inFlight = false;
  }

  // -------- Controls --------
  async function startMonitoring() {
    clearError();
    setStatus("warn", "Starting…");
    els.overlayText.textContent = "Starting…";

    try {
      await startCamera();

      running = true;
      els.startBtn.disabled = true;
      els.stopBtn.disabled = false;

      setStatus("good", "Monitoring");
      els.overlayText.textContent = "Monitoring…";

      resetVoteWindow(Date.now());
      startLoop();
    } catch (e) {
      running = false;
      setStatus("bad", "Camera error");
      els.overlayText.textContent = "Tap Start";
      showError(String(e?.message || e));
    }
  }

  async function stopMonitoring() {
    running = false;
    stopLoop();

    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;

    els.overlayText.textContent = "Tap Start";
    setStatus("warn", "Stopped");

    // don’t kill camera preview completely (feels nicer)
    // BUT if you want to fully stop camera, uncomment:
    // await stopCamera();
  }

  // -------- Health ping --------
  async function pingHealth() {
    try {
      const res = await fetch(`${window.API_BASE}/health`, { method: "GET" });
      if (!res.ok) throw new Error(`Health ${res.status}`);
      setStatus("good", "Ready");
    } catch {
      setStatus("warn", "Ready (health unknown)");
    }
  }

  // -------- Init --------
  function init() {
    // Grab DOM elements (and guarantee they exist)
    els.statusDot = mustGet("statusDot");
    els.statusText = mustGet("statusText");
    els.fpsBadge = mustGet("fpsBadge");
    els.overlayText = mustGet("overlayText");
    els.startBtn = mustGet("startBtn");
    els.stopBtn = mustGet("stopBtn");
    els.switchBtn = mustGet("switchBtn");
    els.video = mustGet("video");
    els.canvas = mustGet("canvas");
    els.errorBox = mustGet("errorBox");

    els.currentLabel = mustGet("currentLabel");
    els.currentConf = mustGet("currentConf");
    els.topKList = mustGet("topKList");

    els.minuteVerdictValue = mustGet("minuteVerdictValue");
    els.minuteVerdictMeta = mustGet("minuteVerdictMeta");

    els.apiBaseText = mustGet("apiBaseText");

    els.apiBaseText.textContent = window.API_BASE;
    els.fpsBadge.textContent = `${FPS} FPS`;

    setStatus("warn", "Idle");
    els.overlayText.textContent = "Tap Start";

    els.startBtn.addEventListener("click", startMonitoring);
    els.stopBtn.addEventListener("click", stopMonitoring);
    els.switchBtn.addEventListener("click", switchCamera);

    pingHealth();

    // optional: preload camera preview without starting monitoring
    // (comment out if you don’t want permission prompt until Start)
    // startCamera().then(() => setStatus("good", "Ready")).catch(() => {});
  }

  window.addEventListener("DOMContentLoaded", init);
})();
