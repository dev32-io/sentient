// localVAD PoC browser client.
//
// Responsibilities:
//   1. Open a WebSocket to the Pi service (ws://raspberrypi.local:8765).
//   2. Capture the mic at 16 kHz mono via an AudioWorklet and stream Int16
//      PCM frames as binary WS messages.
//   3. Parse the server's JSON event stream into a live on-page log.
//   4. When the server emits `turn_complete` (JSON) followed by a binary
//      WAV payload, save that WAV to the recordings list for playback +
//      manual download.
//
// Run the page via `python3 -m http.server 8080 -d .` from pocs/localVAD/
// client/ on your laptop — getUserMedia requires a secure context, and
// localhost counts as secure.

const els = {
  url: document.getElementById("url"),
  connect: document.getElementById("connect"),
  disconnect: document.getElementById("disconnect"),
  connStatus: document.getElementById("conn-status"),
  startMic: document.getElementById("start-mic"),
  stopMic: document.getElementById("stop-mic"),
  micStatus: document.getElementById("mic-status"),
  bytesSent: document.getElementById("bytes-sent"),
  log: document.getElementById("log"),
  recordings: document.getElementById("recordings"),
};

const state = {
  /** @type {WebSocket | null} */
  ws: null,
  /** @type {MediaStream | null} */
  stream: null,
  /** @type {AudioContext | null} */
  audioCtx: null,
  /** @type {AudioWorkletNode | null} */
  worklet: null,
  /** @type {MediaStreamAudioSourceNode | null} */
  source: null,
  /** Number of audio bytes sent since mic start. */
  bytesSent: 0,
  /** Most recent JSON `turn_complete` event awaiting its binary WAV. */
  pendingTurnComplete: null,
};

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setConnStatus(text, cls) {
  els.connStatus.textContent = text;
  els.connStatus.className = `status ${cls || ""}`.trim();
}

function setMicStatus(text, cls) {
  els.micStatus.textContent = text;
  els.micStatus.className = `status ${cls || ""}`.trim();
}

function appendLog(kind, message) {
  const line = document.createElement("div");
  line.className = `log-line log-${kind}`;
  const ts = new Date().toISOString().slice(11, 23);
  line.textContent = `${ts}  ${message}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function updateBytesSent(delta) {
  state.bytesSent += delta;
  els.bytesSent.textContent = `${state.bytesSent.toLocaleString()} B sent`;
}

function addRecording(meta, wavBlob) {
  const li = document.createElement("li");

  const label = document.createElement("span");
  label.textContent = `turn ${meta.turnIdx} · ${(meta.durationMs / 1000).toFixed(2)}s · p=${meta.smartTurnProbability}`;
  label.style.flex = "1";

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.src = URL.createObjectURL(wavBlob);

  const link = document.createElement("a");
  link.href = audio.src;
  link.download = `turn_${String(meta.turnIdx).padStart(3, "0")}.wav`;
  link.textContent = "download";

  li.appendChild(label);
  li.appendChild(audio);
  li.appendChild(link);
  els.recordings.insertBefore(li, els.recordings.firstChild);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function openWebSocket() {
  const url = els.url.value.trim();
  if (!url) {
    appendLog("error", "please enter a ws:// URL");
    return;
  }

  setConnStatus("connecting…", "");
  appendLog("ready", `opening ${url}`);

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    setConnStatus("connected", "connected");
    els.connect.disabled = true;
    els.disconnect.disabled = false;
    els.startMic.disabled = false;
    ws.send(JSON.stringify({ type: "hello", sampleRate: 16000, client: "localvad-poc" }));
    appendLog("ready", "WebSocket open");
  });

  ws.addEventListener("message", onServerMessage);

  ws.addEventListener("close", (ev) => {
    setConnStatus("disconnected", "");
    els.connect.disabled = false;
    els.disconnect.disabled = true;
    els.startMic.disabled = true;
    els.stopMic.disabled = true;
    appendLog("error", `WebSocket closed (code=${ev.code})`);
    state.ws = null;
    stopMic();
  });

  ws.addEventListener("error", () => {
    setConnStatus("error", "error");
    appendLog("error", "WebSocket error (see browser devtools)");
  });

  state.ws = ws;
}

function closeWebSocket() {
  if (state.ws) state.ws.close();
}

function onServerMessage(ev) {
  // Binary: follow-up WAV payload for a pending turn_complete.
  if (ev.data instanceof ArrayBuffer) {
    if (!state.pendingTurnComplete) {
      appendLog("error", `received unexpected binary (${ev.data.byteLength} bytes)`);
      return;
    }
    const meta = state.pendingTurnComplete;
    state.pendingTurnComplete = null;
    const blob = new Blob([ev.data], { type: "audio/wav" });
    addRecording(meta, blob);
    appendLog(
      "turn_complete",
      `saved turn ${meta.turnIdx}: ${(ev.data.byteLength / 1024).toFixed(1)} KiB WAV`,
    );
    return;
  }

  // Text: JSON control events.
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    appendLog("error", `non-JSON text message: ${ev.data}`);
    return;
  }

  switch (msg.type) {
    case "ready":
      appendLog("ready", `server ready (conn=${msg.connId}, sr=${msg.sampleRate})`);
      break;
    case "vad_start":
      appendLog("vad_start", `VAD start (turn ${msg.turnIdx})`);
      break;
    case "vad_end":
      appendLog("vad_end", `VAD end (turn ${msg.turnIdx})`);
      break;
    case "smart_turn_eval":
      appendLog(
        "smart_turn_eval",
        `smart-turn eval: p=${msg.probability} pred=${msg.prediction} in ${msg.evalMs}ms (audio ${msg.audioSeconds}s)`,
      );
      break;
    case "turn_continuing":
      appendLog(
        "turn_continuing",
        `turn continuing: p=${msg.probability} < 0.5, accumulating more audio`,
      );
      break;
    case "turn_complete":
      appendLog(
        "turn_complete",
        `TURN COMPLETE (turn ${msg.turnIdx}): ${msg.durationMs}ms, p=${msg.smartTurnProbability}`,
      );
      state.pendingTurnComplete = msg;
      break;
    case "warning":
      appendLog("error", `warning from server: ${msg.message}`);
      break;
    case "pong":
      break;
    default:
      appendLog("ready", `← ${JSON.stringify(msg)}`);
  }
}

// ---------------------------------------------------------------------------
// Microphone capture
// ---------------------------------------------------------------------------

async function startMic() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    appendLog("error", "WebSocket not open");
    return;
  }
  try {
    // NOTE: we intentionally do NOT request `sampleRate: 16000` on the
    // MediaStreamConstraints. Firefox ignores that hint and returns the
    // native device rate (usually 48000), then refuses to connect the
    // 48 kHz source into a 16 kHz AudioContext. Chrome silently resamples.
    // We sidestep the compatibility landmine entirely by running the
    // AudioContext at the native rate and downsampling to 16 kHz inside
    // the worklet.
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    state.audioCtx = new AudioContext(); // let the browser pick native rate
    appendLog(
      "ready",
      `AudioContext sampleRate = ${state.audioCtx.sampleRate} (worklet will downsample to 16000)`,
    );

    await state.audioCtx.audioWorklet.addModule("./capture-worklet.js");

    state.source = state.audioCtx.createMediaStreamSource(state.stream);
    state.worklet = new AudioWorkletNode(state.audioCtx, "localvad-capture");
    state.worklet.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === "pcm") {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(msg.buffer);
          updateBytesSent(msg.buffer.byteLength);
        }
        return;
      }
      if (msg.type === "worklet-ready") {
        appendLog(
          "ready",
          `worklet resampling ${msg.inputSampleRate} Hz → ${msg.outputSampleRate} Hz (stride=${msg.resampleStride.toFixed(4)})`,
        );
        return;
      }
    };

    state.source.connect(state.worklet);
    // Worklet is a sink; no need to connect it to the destination.

    setMicStatus("capturing", "capturing");
    els.startMic.disabled = true;
    els.stopMic.disabled = false;
    state.bytesSent = 0;
    updateBytesSent(0);
    appendLog("ready", "mic started");
  } catch (err) {
    appendLog("error", `mic start failed: ${err && err.message ? err.message : err}`);
    stopMic();
  }
}

function stopMic() {
  if (state.worklet) {
    try { state.worklet.disconnect(); } catch {}
    state.worklet = null;
  }
  if (state.source) {
    try { state.source.disconnect(); } catch {}
    state.source = null;
  }
  if (state.audioCtx) {
    try { state.audioCtx.close(); } catch {}
    state.audioCtx = null;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  setMicStatus("idle", "");
  els.startMic.disabled = !(state.ws && state.ws.readyState === WebSocket.OPEN);
  els.stopMic.disabled = true;
  appendLog("ready", "mic stopped");
}

// ---------------------------------------------------------------------------
// Wire up buttons
// ---------------------------------------------------------------------------

els.connect.addEventListener("click", openWebSocket);
els.disconnect.addEventListener("click", closeWebSocket);
els.startMic.addEventListener("click", startMic);
els.stopMic.addEventListener("click", stopMic);
