// localSTT PoC browser client.
//
// 1. Open a WebSocket to the Pi service (ws://raspberrypi.local:8766).
// 2. Capture the mic via an AudioWorklet that resamples to 16 kHz and
//    streams Int16 PCM frames as binary WS messages.
// 3. Render the server's JSON event stream into a live log.
// 4. On `turn_complete`, create a turn card with audio playback. On
//    `transcript_ready` (fires a few ms later), fill the card's text.
//
// Serve this page from `python3 -m http.server 8080 -d .` in client/ so
// that getUserMedia is happy with the secure-context requirement.

import {
  els,
  setConnStatus,
  setMicStatus,
  appendLog,
  updateBytesSent,
  addTurnCard,
  fillTranscript,
  stripTags,
} from "./ui.js";

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
  bytesSent: 0,
  /** Most recent JSON `turn_complete` event awaiting its binary WAV. */
  pendingTurnComplete: null,
};

function bumpBytes(delta) {
  state.bytesSent += delta;
  updateBytesSent(state.bytesSent);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

// Persist URL and token between page reloads so you don't retype them
// every iteration of a PoC session. localStorage is per-origin, so this
// is scoped to whatever origin the static server is using (typically
// http://localhost:8080).
const LS_URL_KEY = "localstt.url";
const LS_TOKEN_KEY = "localstt.token";

const savedUrl = localStorage.getItem(LS_URL_KEY);
if (savedUrl) els.url.value = savedUrl;
const savedToken = localStorage.getItem(LS_TOKEN_KEY);
if (savedToken) els.token.value = savedToken;
els.url.addEventListener("change", () => localStorage.setItem(LS_URL_KEY, els.url.value.trim()));
els.token.addEventListener("change", () => localStorage.setItem(LS_TOKEN_KEY, els.token.value.trim()));

function openWebSocket() {
  const url = els.url.value.trim();
  if (!url) {
    appendLog("error", "please enter a ws:// URL");
    return;
  }
  const token = els.token.value.trim();
  // Persist on connect too — in case the user clicked Connect before the
  // input's change event fired.
  localStorage.setItem(LS_URL_KEY, url);
  localStorage.setItem(LS_TOKEN_KEY, token);

  setConnStatus("connecting…", "");
  if (token) {
    appendLog("ready", `opening ${url} (with bearer token)`);
  } else {
    appendLog("ready", `opening ${url} (no token — expect 401 against auth-enabled servers)`);
  }

  // Browser WebSocket cannot set custom HTTP headers, so bearer tokens
  // ride on the Sec-WebSocket-Protocol header via the subprotocol list.
  // Server-side, stt_service/auth.py accepts `["bearer", <token>]` as an
  // alternate auth channel and stt_service/server.py echoes "bearer"
  // back in the handshake response.
  const ws = token ? new WebSocket(url, ["bearer", token]) : new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    setConnStatus("connected", "connected");
    els.connect.disabled = true;
    els.disconnect.disabled = false;
    els.startMic.disabled = false;
    ws.send(JSON.stringify({ type: "hello", sampleRate: 16000, client: "localstt-poc" }));
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
  if (ev.data instanceof ArrayBuffer) {
    if (!state.pendingTurnComplete) {
      appendLog("error", `received unexpected binary (${ev.data.byteLength} bytes)`);
      return;
    }
    const meta = state.pendingTurnComplete;
    state.pendingTurnComplete = null;
    const blob = new Blob([ev.data], { type: "audio/wav" });
    addTurnCard(meta, blob);
    appendLog(
      "turn_complete",
      `saved turn ${meta.turnIdx}: ${(ev.data.byteLength / 1024).toFixed(1)} KiB WAV`,
    );
    return;
  }

  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    appendLog("error", `non-JSON text message: ${ev.data}`);
    return;
  }

  switch (msg.type) {
    case "ready":
      appendLog("ready", `server ready (conn=${msg.connId}, sr=${msg.sampleRate}, stt=${msg.stt || "?"})`);
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
        `smart-turn: p=${msg.probability} pred=${msg.prediction} in ${msg.evalMs}ms (audio ${msg.audioSeconds}s)`,
      );
      break;
    case "turn_continuing":
      appendLog("turn_continuing", `turn continuing: p=${msg.probability} < 0.5`);
      break;
    case "turn_complete":
      appendLog(
        "turn_complete",
        `TURN COMPLETE (turn ${msg.turnIdx}): ${msg.durationMs}ms, p=${msg.smartTurnProbability}`,
      );
      state.pendingTurnComplete = msg;
      break;
    case "turn_rejected":
      appendLog(
        "turn_rejected",
        `turn rejected (turn ${msg.turnIdx}, ${msg.reason}): text=${JSON.stringify(msg.text)}, audio=${msg.audioSeconds}s, decode=${msg.decodeMs}ms`,
      );
      break;
    case "transcript_ready":
      appendLog(
        "transcript_ready",
        `TRANSCRIPT (turn ${msg.turnIdx}) in ${msg.decodeMs}ms: ${stripTags(msg.text)}`,
      );
      fillTranscript(msg);
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
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    state.audioCtx = new AudioContext(); // native rate; worklet resamples to 16 kHz
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
          bumpBytes(msg.buffer.byteLength);
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

els.connect.addEventListener("click", openWebSocket);
els.disconnect.addEventListener("click", closeWebSocket);
els.startMic.addEventListener("click", startMic);
els.stopMic.addEventListener("click", stopMic);
