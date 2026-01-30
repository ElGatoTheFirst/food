(() => {
  // ---------- Config ----------
  const TOP_K = 3;
  const FPS = 1;                 // 1 frame per second
  const MINUTE_MS = 60_000;      // 1 verdict per minute

  // REQUIRED by you (set in index.html). Fallback just in case:
  const API_BASE = (window.API_BASE || "").replace(/\/+$/, "");
  // Show API in footer
  const apiShow = document.getElementById("apiShow");
  if (apiShow) apiShow.textContent = API_BASE || "—";

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);

  const video = $("video");
  const canvas = $("canvas");
  const startBtn = $("startBtn");
  const stopBtn = $("stopBtn");
  const switchBtn = $("switchBtn");

  const statusDot = $("statusDot");
  const statusText = $("statusText");
  const countdownEl = $("countdown");

  const liveLabel = $("liveLabel");
  const liveConf = $("liveConf");
  const liveBadge = $("liveBadge");
  const topKList = $("topKList");

  const minuteLabel = $("minuteLabel");
  const minuteMeta = $("minuteMeta");
  const minuteBadge = $("minuteBadge");
  const historyList = $("historyList");

  const errorBox = $("errorBox");
  const hint = $("hint");

  // Prevent “Cannot set properties of null …” forever:
  const required = [
    video, canvas, startBtn, stopBtn, switchBtn,
    statusDot, statusText, countdownEl,
    liveLabel, liveConf, liveBadge, topKList,
    minuteLabel, minuteMeta, minuteBadge, historyList,
    errorBox
  ];
  if (required.some((x) => !x)) {
    console.error("Missing required DOM elements. Check your index.html IDs.");
    return;
  }

  // ---------- State ----------
  let stream = null;
  let captureTimer = null;
  let minuteTimer = null;

  let usingFront = false;
  let inFlight = false;

  // minute aggregation
  let minuteStart = 0;
  let frameCounts = new Map();     // label -> count
  let confSums = new Map();        // label -> sum(conf)
  let framesThisMinute = 0;

  // ---------- UI ----------
  function setStatus(kind, text) {
    statusText.textContent = text;

    statusDot.classList.remove("on", "err");
    if (kind === "on") statusDot.classList.add("on");
    if (kind === "err") statusDot.classList.add("err");
  }

  function showError(msg) {
    errorBox.hidden = false;
    errorBox.textContent = msg;
    setStatus("err", "Error");
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function fmtPct(x) {
    if (typeof x !== "number" || !isFinite(x)) return "—";
    return `${(x * 100).toFixed(1)}%`;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function updateCountdown() {
    if (!minuteStart) {
      countdownEl.textContent = "60s";
      return;
    }
    const elapsed = Date.now() - minuteStart;
    const left = Math.max(0, MINUTE_MS - elapsed);
    const sec = Math.ceil(left / 1000);
    countdownEl.textContent = `${sec}s`;
  }

  // ---------- Camera ----------
  async function startCamera() {
    clearError();

    if (!API_BASE) {
      showError('API_BASE is empty. Make sure index.html sets window.API_BASE = "https://elgatito1-food-classifier.hf.space";');
      return;
    }

    // Stop existing stream first
    stopCamera();

    try {
      setStatus("", "Requesting camera…");

      const constraints = {
        audio: false,
        video: {
          facingMode: usingFront ? "user" : { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;

      await video.play();

      if (hint) hint.textContent = "Running… 1 frame per second.";

      setStatus("on", "Live");
      startBtn.disabled = true;
      stopBtn.disabled = false;

      startLoops();
    } catch (e) {
      console.error(e);
      showError("Camera permission denied or not available. Try another browser, or switch camera.");
    }
  }

  function stopCamera() {
    if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
    if (minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }

    if (video) {
      video.pause?.();
      video.srcObject = null;
    }

    if (stream) {
      for (const t of stream.getTracks()) t.stop();
      stream = null;
    }

    inFlight = false;

    setStatus("", "Idle");
    startBtn.disabled = false;
    stopBtn.disabled = true;

    // reset countdown display
    minuteStart = 0;
    updateCountdown();
  }

  async function switchCamera() {
    usingFront = !usingFront;
    if (stopBtn.disabled) return; // not running
    await startCamera();
  }

  // ---------- Capture & API ----------
  function drawToCanvas() {
    // Ensure we have video dimensions
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh) return false;

    const size = Math.min(vw, vh);
    const sx = Math.floor((vw - size) / 2);
    const sy = Math.floor((vh - size) / 2);

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = 640;
    canvas.height = 640;

    ctx.drawImage(video, sx, sy, size, size, 0, 0, canvas.width, canvas.height);
    return true;
  }

  function canvasToBlob() {
    return new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9);
    });
  }

  async function sendFrame() {
    if (inFlight) return;
    if (!stream) return;

    const ok = drawToCanvas();
    if (!ok) return;

    inFlight = true;
    try {
      const blob = await canvasToBlob();
      if (!blob) throw new Error("Could not encode frame.");

      const form = new FormData();
      form.append("file", blob, "frame.jpg");

      const url = `${API_BASE}/predict?top_k=${TOP_K}`;

      const res = await fetch(url, {
        method: "POST",
        body: form,
        mode: "cors"
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${txt.slice(0, 150)}`);
      }

      const data = await res.json();
      clearError();
      renderLive(data);
      aggregateForMinute(data);
    } catch (e) {
      console.error(e);
      showError(String(e.message || e));
    } finally {
      inFlight = false;
    }
  }

  function renderLive(data) {
    const label = data?.predicted_label ?? "—";
    const conf = data?.confidence;

    liveLabel.textContent = label;
    liveConf.textContent = `Confidence: ${fmtPct(conf)}`;
    liveBadge.textContent = `top_k=${TOP_K}`;

    // Top-K list
    topKList.innerHTML = "";
    const arr = Array.isArray(data?.top_k) ? data.top_k : [];
    for (const item of arr) {
      const li = document.createElement("li");
      const left = document.createElement("div");
      const right = document.createElement("div");

      left.className = "kleft";
      right.className = "kprob";

      const name = document.createElement("div");
      name.className = "kname";
      name.textContent = item?.label ?? item?.class ?? "—";

      left.appendChild(name);
      right.textContent = fmtPct(item?.prob);

      const row = document.createElement("div");
      row.className = "krow";
      row.appendChild(left);
      row.appendChild(right);

      li.appendChild(row);
      topKList.appendChild(li);
    }
  }

  // ---------- Minute verdict logic ----------
  function resetMinute() {
    frameCounts = new Map();
    confSums = new Map();
    framesThisMinute = 0;
    minuteStart = Date.now();
    updateCountdown();

    minuteLabel.textContent = "—";
    minuteMeta.textContent = "Collecting frames…";
    minuteBadge.textContent = "Running";
    minuteBadge.classList.add("ok");
  }

  function aggregateForMinute(data) {
    if (!minuteStart) resetMinute();

    const label = data?.predicted_label;
    const conf = (typeof data?.confidence === "number") ? data.confidence : 0;

    if (!label) return;

    framesThisMinute += 1;
    frameCounts.set(label, (frameCounts.get(label) || 0) + 1);
    confSums.set(label, (confSums.get(label) || 0) + conf);

    // show progress
    minuteMeta.textContent = `Frames this minute: ${framesThisMinute}`;
  }

  function finalizeMinuteVerdict() {
    if (!minuteStart) return;

    // If no frames captured
    if (framesThisMinute === 0 || frameCounts.size === 0) {
      minuteLabel.textContent = "No frames captured";
      minuteMeta.textContent = "Try better lighting / keep object centered.";
      minuteBadge.textContent = "—";
      return;
    }

    // pick label with highest count; tie-break by higher avg confidence
    let bestLabel = null;
    let bestCount = -1;
    let bestAvg = -1;

    for (const [label, count] of frameCounts.entries()) {
      const sum = confSums.get(label) || 0;
      const avg = sum / Math.max(1, count);

      if (count > bestCount || (count === bestCount && avg > bestAvg)) {
        bestLabel = label;
        bestCount = count;
        bestAvg = avg;
      }
    }

    const now = Date.now();
    minuteLabel.textContent = bestLabel;
    minuteMeta.textContent = `${bestCount}/${framesThisMinute} frames • avg conf ${fmtPct(bestAvg)} • ${fmtTime(now)}`;
    minuteBadge.textContent = "VERDICT";

    // add to history
    const li = document.createElement("li");
    const left = document.createElement("div");
    const right = document.createElement("div");
    left.className = "hlabel";
    right.className = "hmeta";

    left.textContent = bestLabel;
    right.textContent = `${bestCount}/${framesThisMinute} • ${fmtTime(now)}`;

    li.appendChild(left);
    li.appendChild(right);

    historyList.insertBefore(li, historyList.firstChild);

    // keep history short
    while (historyList.children.length > 6) {
      historyList.removeChild(historyList.lastChild);
    }

    // start new minute window
    resetMinute();
  }

  function startLoops() {
    // Minute window starts immediately when you start monitoring
    resetMinute();

    // 1 FPS capture
    const intervalMs = Math.floor(1000 / FPS);
    captureTimer = setInterval(sendFrame, intervalMs);

    // Countdown + finalize every minute (fix for “always shows -”)
    minuteTimer = setInterval(() => {
      updateCountdown();
      if (!minuteStart) return;

      const elapsed = Date.now() - minuteStart;
      if (elapsed >= MINUTE_MS) {
        finalizeMinuteVerdict();
      }
    }, 250);
  }

  // ---------- Events ----------
  startBtn.addEventListener("click", startCamera);
  stopBtn.addEventListener("click", stopCamera);
  switchBtn.addEventListener("click", switchCamera);

  // initial UI
  setStatus("", "Idle");
  updateCountdown();
})();
