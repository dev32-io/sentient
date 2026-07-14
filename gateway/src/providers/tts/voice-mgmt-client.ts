import type { Result } from "@sentient/protocol";
import { getLog } from "../../logging/logger.ts";
import {
  type LocalTtsFrame,
  type LocalTtsVoiceInfo,
  buildConnectUrl,
  parseServerFrame,
  voiceCreateMsg,
  voiceDeleteMsg,
  voiceListMsg,
} from "./local-tts-protocol.ts";

const log = getLog(["sentient", "tts", "voice-mgmt"]);

const READY_STATE_OPEN = 1;

export type VoiceMgmtSocketFactory = (url: string) => WebSocket;

export interface VoiceMgmtConfig {
  readonly url: string;
  readonly connectTimeoutMs: number;
  readonly opTimeoutMs: number;
  /** Production uses the global WebSocket; tests inject a fake. */
  readonly socketFactory?: VoiceMgmtSocketFactory;
}

/**
 * `service-error` = the service replied `{type:"error", reason}` (bad/short
 * clip, structurally-invalid voiceId) — client-ish, maps to 422. `timeout` =
 * connected but no matching reply within `opTimeoutMs`. `transport` = the WS
 * never connected (bad URL, connect-timeout, connect-time error/close, or an
 * aborted signal).
 */
export type VoiceOpError = { kind: "service-error"; reason: string } | { kind: "timeout" } | { kind: "transport" };

export interface VoiceCreated {
  readonly voiceId: string;
  readonly name: string;
}

export interface VoiceListResult {
  readonly voices: readonly LocalTtsVoiceInfo[];
}

export interface VoiceDeleted {
  readonly voiceId: string;
}

/** One short-lived WS: connect -> send request [+ binary] -> await the one matching
 *  reply -> close. `sendRequest` fires on open; `extract` returns non-null for the
 *  frame kind this op is waiting on (all other non-error/ready frames are ignored). */
async function requestReply<T>(
  cfg: VoiceMgmtConfig,
  sendRequest: (socket: WebSocket) => void,
  extract: (frame: LocalTtsFrame) => T | null,
  signal: AbortSignal,
): Promise<Result<T, VoiceOpError>> {
  if (signal.aborted) return { ok: false, error: { kind: "transport" } };

  const factory = cfg.socketFactory ?? ((url: string) => new WebSocket(url));
  const connectUrl = buildConnectUrl(cfg.url);
  const socket = openSocket(factory, connectUrl);
  if (!socket) return { ok: false, error: { kind: "transport" } };

  return new Promise((resolve) => {
    const settle = makeSettler(socket, resolve);
    signal.addEventListener("abort", () => settle({ ok: false, error: { kind: "transport" } }), { once: true });
    wireOpSocket(socket, cfg, sendRequest, extract, settle);
  });
}

/** Attempts synchronous socket construction; returns null (never throws) on failure. */
function openSocket(factory: VoiceMgmtSocketFactory, url: string): WebSocket | null {
  try {
    const socket = factory(url);
    socket.binaryType = "arraybuffer";
    return socket;
  } catch (err) {
    log.warn("connect-failed", { reason: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Builds a settle-once function: clears timers, closes the socket, resolves. */
function makeSettler<T>(
  socket: WebSocket,
  resolve: (result: Result<T, VoiceOpError>) => void,
): (result: Result<T, VoiceOpError>) => void {
  let settled = false;
  return (result) => {
    if (settled) return;
    settled = true;
    if (socket.readyState === READY_STATE_OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    resolve(result);
  };
}

function wireOpSocket<T>(
  socket: WebSocket,
  cfg: VoiceMgmtConfig,
  sendRequest: (socket: WebSocket) => void,
  extract: (frame: LocalTtsFrame) => T | null,
  settle: (result: Result<T, VoiceOpError>) => void,
): void {
  const connectTimer = setTimeout(() => {
    log.warn("connect-timeout", { timeoutMs: cfg.connectTimeoutMs });
    settle({ ok: false, error: { kind: "transport" } });
  }, cfg.connectTimeoutMs);

  socket.onopen = () => {
    clearTimeout(connectTimer);
    const opTimer = setTimeout(() => {
      log.warn("op-timeout", { timeoutMs: cfg.opTimeoutMs });
      settle({ ok: false, error: { kind: "timeout" } });
    }, cfg.opTimeoutMs);
    socket.onclose = () => {
      clearTimeout(opTimer);
      settle({ ok: false, error: { kind: "transport" } });
    };
    sendRequest(socket);
  };

  socket.onmessage = (event: MessageEvent) => {
    const frame = parseServerFrame(event.data as string | ArrayBuffer);
    if (frame.kind === "ready") return; // connect-time frame, not the op reply
    if (frame.kind === "error") {
      settle({ ok: false, error: { kind: "service-error", reason: frame.reason } });
      return;
    }
    const value = extract(frame);
    if (value !== null) settle({ ok: true, value });
  };

  socket.onerror = () => {
    log.warn("ws-error");
    settle({ ok: false, error: { kind: "transport" } });
  };

  socket.onclose = () => {
    clearTimeout(connectTimer);
    settle({ ok: false, error: { kind: "transport" } });
  };
}

export async function createVoice(
  cfg: VoiceMgmtConfig,
  name: string,
  audio: ArrayBuffer,
  signal: AbortSignal,
): Promise<Result<VoiceCreated, VoiceOpError>> {
  log.info("create.request", { nameLength: name.length, byteLength: audio.byteLength });
  const started = Date.now();
  const result = await requestReply<VoiceCreated>(
    cfg,
    (socket) => {
      socket.send(voiceCreateMsg(name));
      socket.send(audio);
    },
    (frame) => (frame.kind === "voiceCreated" ? { voiceId: frame.voiceId, name: frame.name } : null),
    signal,
  );
  logOutcome("create", result, started);
  return result;
}

export async function listVoices(
  cfg: VoiceMgmtConfig,
  signal: AbortSignal,
): Promise<Result<VoiceListResult, VoiceOpError>> {
  log.info("list.request", {});
  const started = Date.now();
  const result = await requestReply<VoiceListResult>(
    cfg,
    (socket) => socket.send(voiceListMsg()),
    (frame) => (frame.kind === "voiceList" ? { voices: frame.voices } : null),
    signal,
  );
  logOutcome("list", result, started, (v) => ({ count: v.voices.length }));
  return result;
}

export async function deleteVoice(
  cfg: VoiceMgmtConfig,
  voiceId: string,
  signal: AbortSignal,
): Promise<Result<VoiceDeleted, VoiceOpError>> {
  log.info("delete.request", { voiceId });
  const started = Date.now();
  const result = await requestReply<VoiceDeleted>(
    cfg,
    (socket) => socket.send(voiceDeleteMsg(voiceId)),
    (frame) => (frame.kind === "voiceDeleted" ? { voiceId: frame.voiceId } : null),
    signal,
  );
  logOutcome("delete", result, started);
  return result;
}

function logOutcome<T>(
  op: string,
  result: Result<T, VoiceOpError>,
  startedAtMs: number,
  extra?: (value: T) => Record<string, unknown>,
): void {
  const elapsedMs = Date.now() - startedAtMs;
  if (result.ok) {
    log.info(`${op}.success`, { elapsedMs, ...(extra ? extra(result.value) : {}) });
  } else {
    log.warn(`${op}.failed`, { elapsedMs, kind: result.error.kind });
  }
}
