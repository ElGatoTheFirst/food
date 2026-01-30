(() => {
  const API_BASE = (window.API_BASE || "").replace(/\/$/, ""); // "" = same-origin

  const $ = (id) => document.getElementById(id);

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function setError(err) {
    setText("error", err ? String(err) : "");
  }

  async function checkHealth() {
    try {
      const r = await fetch(`${API_BASE}/health`);
      const t = await r.text();
      if (!r.ok) throw new Error(`Health check failed (${r.status}): ${t.slice(0, 200)}`);
      setText("status", `API OK ✅ ${t}`);
      setError("");
    } catch (e) {
      setText(
        "status",
        "API not reachable. If using GitHub Pages, set window.API_BASE to your Space URL."
      );
      setError(e);
    }
  }

  let stream = null;
  let timer = null;
  let busy = false;

  async function startCamera() {
    const video = $("video");
    if (!video) throw new Error("Missing <video id='video'> in HTML.");

    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });

    video.srcObject = stream;
    await video.play();
  }

  function stopCamera() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    setText("status", "Stopped.");
  }

  function captureToBlob() {
    const video = $("video");
    const canvas = $("canvas");
    if (!video || !canvas) throw new Error("Missing #video or #canvas in HTML.");

    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;

    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);

    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  }

  async function sendFrame(topK) {
    const blob = await captureToBlob();
    if (!blob) throw new Error("Failed to capture frame.");

    const fd = new FormData();
    fd.append("file", blob, "frame.jpg");

    const url = `${API_BASE}/predict?top_k=${encodeURIComponent(topK)}`;
    const res = await fetch(url, { method: "POST", body: fd });

    const text = await res.text();

    if (!res.ok) {
      // Show a short snippet so the UI doesn't spam huge HTML pages
      throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
    }

    return JSON.parse(text);
  }

  function renderResult(data) {
    // Expected keys from your API: predicted_label, confidence, top_k, top_k_probs, top_k_classes, top_k_labels :contentReference[oaicite:2]{index=2}
    const out = {
      predicted_label: data?.predicted_label,
      confidence: data?.confidence,
      top_k: data?.top_k,
      top_k_probs: data?.top_k_probs,
      top_k_labels: data?.top_k_labels,
      top_k_classes: data?.top_k_classes,
    };
    setText("result", JSON.stringify(out, null, 2));
  }

  async function captureOnce() {
    if (busy) return;
    busy = true;

    try {
      const topK = Number($("topK")?.value || 3);
      const data = await sendFrame(topK);
      setText("status", "Prediction OK ✅");
      setError("");
      renderResult(data);
    } catch (e) {
      setText("status", "Prediction failed ❌");
      setError(e);
    } finally {
      busy = false;
    }
  }

  function startLoop() {
    const intervalMs = Math.max(250, Number($("intervalMs")?.value || 1500));
    if (timer) clearInterval(timer);
    timer = setInterval(captureOnce, intervalMs);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // Ensure required elements exist (prevents your “null.textContent” crash)
    if (!$("status") || !$("error") || !$("result") || !$("video") || !$("canvas")) {
      console.error("Your HTML is missing required elements. Use the provided index.html.");
    }

    await checkHealth();

    $("startBtn")?.addEventListener("click", async () => {
      try {
        setError("");
        setText("status", "Starting camera…");
        await startCamera();
        startLoop();
        $("startBtn").disabled = true;
        $("stopBtn").disabled = false;
        setText("status", "Running…");
      } catch (e) {
        setText("status", "Camera start failed ❌");
        setError(e);
      }
    });

    $("stopBtn")?.addEventListener("click", () => {
      stopCamera();
      $("startBtn").disabled = false;
      $("stopBtn").disabled = true;
    });
  });
})();
