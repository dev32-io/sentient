import type { Result } from "@sentient/protocol";
import { getLog } from "../../logging/logger.ts";
import {
  type LocalTtsFrame,
  buildConnectUrl,
  cancelMsg,
  endMsg,
  parseServerFrame,
  textMsg,
} from "./local-tts-protocol.ts";
import type { VoiceMgmtSocketFactory, VoiceOpError } from "./voice-mgmt-client.ts";

const log = getLog(["sentient", "tts", "preview-synth"]);

const PREVIEW_SAMPLE_RATE = 24000; // source rate — avoids upsampling; small clip
const READY_STATE_OPEN = 1;

export interface PreviewSynthConfig {
  readonly url: string;
  readonly connectTimeoutMs: number;
  readonly opTimeoutMs: number;
  /** Production uses the global WebSocket; tests inject a fake. */
  readonly socketFactory?: VoiceMgmtSocketFactory;
}

export interface PreviewPcm {
  readonly pcm: Uint8Array;
  readonly sampleRate: number;
}

/** Mutable handles for the connect/op timers — see voice-mgmt-client.ts's
 *  TimerHandles for why both are cleared directly by `settle` rather than
 *  relying on the async `onclose` side-effect. */
interface TimerHandles {
  connectTimer?: ReturnType<typeof setTimeout> | undefined;
  opTimer?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * One-shot preview synth: connect targeting `voiceId`, send one greeting +
 * `end`, accumulate `audio` frames until `done`, resolve with the
 * concatenated PCM. Mirrors `voice-mgmt-client.ts`'s connect/settle/timer
 * skeleton (`requestReply`/`makeSettler`/`wireOpSocket`/`onSocketOpen`), but
 * accumulates rather than resolving on the first matching reply.
 */
export async function synthesizePreview(
  cfg: PreviewSynthConfig,
  voiceId: string,
  text: string,
  signal: AbortSignal,
): Promise<Result<PreviewPcm, VoiceOpError>> {
  log.info("preview.request", { voiceId, textLength: text.length });
  const started = Date.now();
  if (signal.aborted) return { ok: false, error: { kind: "transport" } };

  const socket = openSocket(cfg, voiceId);
  if (!socket) return { ok: false, error: { kind: "transport" } };

  const result = await new Promise<Result<PreviewPcm, VoiceOpError>>((resolve) => {
    const timers: TimerHandles = {};
    const settle = makeSettle(socket, timers, resolve);
    signal.addEventListener("abort", () => settle({ ok: false, error: { kind: "transport" } }), { once: true });
    runPreview(socket, cfg, text, timers, settle);
  });
  logOutcome(result, started);
  return result;
}

/** Attempts synchronous socket construction targeting `voiceId`; returns
 *  null (never throws) on failure — mirrors voice-mgmt-client.ts's
 *  `openSocket`. */
function openSocket(cfg: PreviewSynthConfig, voiceId: string): WebSocket | null {
  const factory = cfg.socketFactory ?? ((url: string) => new WebSocket(url));
  const url = buildConnectUrl(cfg.url, { format: "pcm", sampleRate: PREVIEW_SAMPLE_RATE, voice: voiceId });
  try {
    const socket = factory(url);
    socket.binaryType = "arraybuffer";
    return socket;
  } catch (err) {
    log.warn("connect-failed", { errorType: err instanceof Error ? "error" : "non-error" });
    return null;
  }
}

/** Arms the connect-deadline timer and wires all four socket handlers. */
function runPreview(
  socket: WebSocket,
  cfg: PreviewSynthConfig,
  text: string,
  timers: TimerHandles,
  settle: (result: Result<PreviewPcm, VoiceOpError>) => void,
): void {
  const chunks: Uint8Array[] = [];
  timers.connectTimer = setTimeout(() => {
    log.warn("connect-timeout", { timeoutMs: cfg.connectTimeoutMs });
    settle({ ok: false, error: { kind: "transport" } });
  }, cfg.connectTimeoutMs);

  socket.onopen = () => onOpen(socket, cfg, text, timers, settle);
  socket.onmessage = (event: MessageEvent) => onMessage(event, chunks, settle);
  socket.onerror = () => {
    log.warn("ws-error");
    settle({ ok: false, error: { kind: "transport" } });
  };
  socket.onclose = () => settle({ ok: false, error: { kind: "transport" } });
}

/** `onopen`: clear the connect deadline (it no longer applies once live), arm
 *  the op timer, and send the one-shot greeting + `end`. */
function onOpen(
  socket: WebSocket,
  cfg: PreviewSynthConfig,
  text: string,
  timers: TimerHandles,
  settle: (result: Result<PreviewPcm, VoiceOpError>) => void,
): void {
  clearTimeout(timers.connectTimer);
  timers.connectTimer = undefined;
  timers.opTimer = setTimeout(() => {
    log.warn("op-timeout", { timeoutMs: cfg.opTimeoutMs });
    settle({ ok: false, error: { kind: "timeout" } });
  }, cfg.opTimeoutMs);
  socket.send(textMsg(text));
  socket.send(endMsg());
}

/** `ready` is a connect-time frame (ignored); `audio` accumulates; `error`
 *  settles service-error; `done` settles ok with the concatenated PCM. */
function onMessage(
  event: MessageEvent,
  chunks: Uint8Array[],
  settle: (result: Result<PreviewPcm, VoiceOpError>) => void,
): void {
  const frame: LocalTtsFrame = parseServerFrame(event.data as string | ArrayBuffer);
  if (frame.kind === "ready") return;
  if (frame.kind === "audio") {
    chunks.push(frame.data);
    return;
  }
  if (frame.kind === "error") {
    settle({ ok: false, error: { kind: "service-error", reason: frame.reason } });
    return;
  }
  if (frame.kind === "done") {
    const pcm = concat(chunks);
    log.debug("preview.audio-done", { chunkCount: chunks.length, pcmBytes: pcm.byteLength });
    settle({ ok: true, value: { pcm, sampleRate: PREVIEW_SAMPLE_RATE } });
  }
}

/** Builds a settle-once function: clears both timers directly, best-effort
 *  cancels the in-flight synth, closes the socket, resolves. */
function makeSettle(
  socket: WebSocket,
  timers: TimerHandles,
  resolve: (result: Result<PreviewPcm, VoiceOpError>) => void,
): (result: Result<PreviewPcm, VoiceOpError>) => void {
  let settled = false;
  return (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timers.connectTimer);
    clearTimeout(timers.opTimer);
    if (socket.readyState === READY_STATE_OPEN || socket.readyState === WebSocket.CONNECTING) {
      try {
        socket.send(cancelMsg());
      } catch {
        // best-effort — the socket may already be closing
      }
      socket.close();
    }
    resolve(result);
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function logOutcome(result: Result<PreviewPcm, VoiceOpError>, startedAtMs: number): void {
  const elapsedMs = Date.now() - startedAtMs;
  if (result.ok) {
    log.info("preview.success", { elapsedMs, byteLength: result.value.pcm.length });
  } else {
    log.warn("preview.failed", { elapsedMs, kind: result.error.kind });
  }
}
