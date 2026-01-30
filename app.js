document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);

  // Tabs / panels
  const tabCamera = $("tabCamera");
  const tabUpload = $("tabUpload");
  const panelCamera = $("panelCamera");
  const panelUpload = $("panelUpload");

  // Camera elements
  const video = $("video");
  const canvas = $("canvas");
  const btnStart = $("btnStart");
  const btnStop = $("btnStop");
  const topKCam = $("topKCam");
  const minuteBadge = $("minuteBadge");

  // Upload elements
  const fileInput = $("fileInput");
  const previewImg = $("previewImg");
  const previewEmpty = $("previewEmpty");
  const btnPredict = $("btnPredict");
  const topKUpload = $("topKUpload");

  // Result elements
  const statusEl = $("status");
  const apiPill = $("apiPill");
  const minuteLabel = $("minuteLabel");
  const minuteSub = $("minuteSub");
  const lastFrameLabel = $("lastFrameLabel");
  const lastFrameConf = $("lastFrameConf");
  const voteCount = $("voteCount");
  const progressFill = $("progressFill");
  const voteList = $("voteList");

  // API base (required)
  const API_BASE = (window.API_BASE || "").replace(/\/$/, "");
  apiPill.textContent = API_BASE ? `API: ${API_BASE}` : "API: (missing)";
  if (!API_BASE) setStatus("err", "window.API_BASE is not set.");

  function setStatus(kind, msg) {
    statusEl.className = `status ${kind || ""}`;
    statusEl.textContent = msg;
  }

  function fmtPct(x) {
    if (x == null || Number.isNaN(x)) return "—";
    const p = Math.max(0, Math.min(1, Number(x))) * 100;
    return `${p.toFixed(1)}%`;
  }

  function switchMode(mode) {
    const isCam = mode === "camera";
    tabCamera.classList.toggle("isActive", isCam);
    tabUpload.classList.toggle("isActive", !isCam);
    panelCamera.classList.toggle("hidden", !isCam);
    panelUpload.classList.toggle("hidden", isCam);
  }

  tabCamera.addEventListener("click", () => switchMode("camera"));
  tabUpload.addEventListener("click", () => switchMode("upload"));

  // ----------- Upload prediction -----------
  let selectedFile = null;

  fileInput.addEventListener("change", () => {
    selectedFile = fileInput.files?.[0] || null;
    btnPredict.disabled = !selectedFile;

    if (!selectedFile) {
      previewImg.classList.add("hidden");
      previewEmpty.classList.remove("hidden");
      return;
    }

    const url = URL.createObjectURL(selectedFile);
    previewImg.src = url;
    previewImg.onload = () => URL.revokeObjectURL(url);

    previewEmpty.classList.add("hidden");
    previewImg.classList.remove("hidden");
  });

  btnPredict.addEventListener("click", async () => {
    if (!selectedFile) return;

    try {
      setStatus("work", "Predicting image…");
      const k = clampInt(topKUpload.value, 3, 1, 10);
      const data = await predictWithBlob(selectedFile, k);
      showLastFrame(data);
      setStatus("ok", "Done ✅");
    } catch (e) {
      setStatus("err", e?.message || "Upload predict failed.");
    }
  });

  // ----------- Camera monitoring (1 fps + 1 verdict/min) -----------
  let stream = null;
  let tickTimer = null;
  let secondTimer = null;
  let inFlight = false;
  let controller = null;

  const FPS = 1;
  const FRAMES_PER_MINUTE = 60;

  // votes[label] = count
  let votes = new Map();
  // confSum[label] = sum of confidences for that label
  let confSum = new Map();
  let framesSeen = 0;
  let secondsLeft = 60;

  function resetMinute() {
    votes = new Map();
    confSum = new Map();
    framesSeen = 0;
    secondsLeft = 60;
    updateMinuteUI();
    minuteLabel.textContent = "—";
    minuteSub.textContent = "Collecting votes…";
    voteList.innerHTML = "";
  }

  function updateMinuteUI() {
    minuteBadge.textContent = `00:${String(secondsLeft).padStart(2, "0")}`;
    voteCount.textContent = `${framesSeen} / ${FRAMES_PER_MINUTE}`;
    progressFill.style.width = `${Math.min(100, (framesSeen / FRAMES_PER_MINUTE) * 100)}%`;
  }

  function clampInt(v, fallback, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  async function startCamera() {
    if (!API_BASE) return;

    try {
      setStatus("work", "Starting camera…");
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 640 },
          height: { ideal: 480 }
        },
        audio: false
      });

      video.srcObject = stream;
      await video.play();

      btnStart.disabled = true;
      btnStop.disabled = false;

      resetMinute();
      setStatus("ok", "Running (1 frame/sec)…");

      // Countdown timer (1 sec)
      secondTimer = setInterval(() => {
        secondsLeft = Math.max(0, secondsLeft - 1);
        updateMinuteUI();

        if (secondsLeft <= 0) {
          // finalize minute
          finalizeMinuteVerdict();
          // restart next minute
          resetMinute();
        }
      }, 1000);

      // Capture loop (1 fps)
      const intervalMs = Math.round(1000 / FPS);
      tickTimer = setInterval(captureOnce, intervalMs);

    } catch (e) {
      setStatus("err", "Camera permission denied or unavailable.");
      stopCamera();
    }
  }

  function stopCamera() {
    if (tickTimer) clearInterval(tickTimer);
    if (secondTimer) clearInterval(secondTimer);
    tickTimer = null;
    secondTimer = null;

    if (controller) controller.abort();
    controller = null;
    inFlight = false;

    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;

    btnStart.disabled = false;
    btnStop.disabled = true;

    setStatus("ok", "Stopped.");
  }

  btnStart.addEventListener("click", startCamera);
  btnStop.addEventListener("click", stopCamera);

  async function captureOnce() {
    if (!stream || !API_BASE) return;
    if (inFlight) return; // prevent piling requests if API is slow

    // Make sure video is ready
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    inFlight = true;
    controller = new AbortController();

    try {
      // Draw current frame
      const w = 640;
      const h = Math.round((video.videoHeight / video.videoWidth) * w);
      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);

      // Convert to blob
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (!blob) throw new Error("Could not encode frame.");

      const k = clampInt(topKCam.value, 3, 1, 10);
      const data = await predictWithBlob(blob, k, controller.signal);

      // Update "last frame"
      showLastFrame(data);

      // Vote
      const label = data?.predicted_label ?? "Unknown";
      const conf = Number(data?.confidence ?? 0);

      votes.set(label, (votes.get(label) || 0) + 1);
      confSum.set(label, (confSum.get(label) || 0) + (Number.isFinite(conf) ? conf : 0));
      framesSeen = Math.min(FRAMES_PER_MINUTE, framesSeen + 1);

      updateMinuteUI();
      renderVoteList();

      // (optional) if we already collected 60 frames before timer ends, finalize early
      if (framesSeen >= FRAMES_PER_MINUTE) {
        finalizeMinuteVerdict();
        resetMinute();
      }

    } catch (e) {
      // Don’t spam errors every second; show a short message
      setStatus("err", (e?.message || "Frame predict failed.").slice(0, 120));
    } finally {
      inFlight = false;
      controller = null;
    }
  }

  function showLastFrame(data) {
    const label = data?.predicted_label ?? "—";
    lastFrameLabel.textContent = label;
    lastFrameConf.textContent = data?.confidence != null ? `Confidence: ${fmtPct(data.confidence)}` : "—";
  }

  function finalizeMinuteVerdict() {
    if (votes.size === 0) {
      minuteLabel.textContent = "—";
      minuteSub.textContent = "No frames collected this minute.";
      return;
    }

    // winner = max votes
    let winner = null;
    let best = -1;

    for (const [label, count] of votes.entries()) {
      if (count > best) {
        best = count;
        winner = label;
      }
    }

    const avgConf = (() => {
      const s = confSum.get(winner) || 0;
      const c = votes.get(winner) || 1;
      return s / c;
    })();

    minuteLabel.textContent = winner;
    minuteSub.textContent = `Winner with ${best} / ${framesSeen} frames • Avg confidence ${fmtPct(avgConf)}`;

    setStatus("ok", "Minute verdict updated ✅");
  }

  function renderVoteList() {
    // Sort by votes descending
    const entries = Array.from(votes.entries()).sort((a, b) => b[1] - a[1]);
    const maxVotes = entries.length ? entries[0][1] : 1;

    voteList.innerHTML = "";
    entries.slice(0, 6).forEach(([label, count]) => {
      const li = document.createElement("li");
      li.className = "rowItem";

      const top = document.createElement("div");
      top.className = "rowTop";

      const name = document.createElement("div");
      name.className = "rowName";
      name.textContent = label;

      const right = document.createElement("div");
      right.className = "rowVotes";
      right.textContent = `${count} vote${count === 1 ? "" : "s"}`;

      top.appendChild(name);
      top.appendChild(right);

      const bar = document.createElement("div");
      bar.className = "rowBar";

      const fill = document.createElement("div");
      fill.className = "rowFill";
      fill.style.width = `${Math.round((count / maxVotes) * 100)}%`;

      bar.appendChild(fill);

      li.appendChild(top);
      li.appendChild(bar);
      voteList.appendChild(li);
    });
  }

  async function predictWithBlob(blobOrFile, topK = 3, signal) {
    const url = `${API_BASE}/predict?top_k=${encodeURIComponent(topK)}`;
    const fd = new FormData();
    fd.append("file", blobOrFile, "frame.jpg");

    const res = await fetch(url, {
      method: "POST",
      body: fd,
      mode: "cors",
      signal
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${txt.slice(0, 160)}`);
    }
    return await res.json();
  }

  // Default mode
  switchMode("camera");
  setStatus("ok", "Ready.");
});
