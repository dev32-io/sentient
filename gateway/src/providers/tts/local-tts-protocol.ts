// ---------------------------------------------------------------------------
// local-tts-protocol — WS message codec for the native LocalTTSService.
//
// Wire contract: capabilityServices/LocalTTSService/CONTRACT.md. This
// service speaks JSON text frames for control messages and raw binary
// frames for audio — no MessagePack.
//
// The service's JSON field names are a mix of camelCase (`requestId`,
// `voiceId`, `createdAt`) and snake_case (`sample_rate`, `ttfa_ms`,
// `audio_seconds`) — CONTRACT.md is the source of truth for exactly which.
// Builders emit the wire shape verbatim; parseServerFrame normalizes every
// parsed frame to camelCase fields, matching this codebase's TS convention
// (see TTSAudioChunk.sampleRate in tts-types.ts).
// ---------------------------------------------------------------------------

/** Client -> server JSON message `type` values (CONTRACT.md §3.1, §4). */
const CLIENT_MSG_TYPE = {
  TEXT: "text",
  FLUSH: "flush",
  END: "end",
  CANCEL: "cancel",
  PING: "ping",
  VOICE_CREATE: "voice.create",
  VOICE_LIST: "voice.list",
  VOICE_DELETE: "voice.delete",
} as const;

/** Server -> client JSON frame `type` values (CONTRACT.md §5.1). */
const SERVER_MSG_TYPE = {
  READY: "ready",
  STARTED: "started",
  DONE: "done",
  WARNING: "warning",
  ERROR: "error",
  PONG: "pong",
  VOICE_CREATED: "voice.created",
  VOICE_LIST: "voice.list",
  VOICE_DELETED: "voice.deleted",
} as const;

export interface LocalTtsConnectOptions {
  readonly format?: string;
  readonly sampleRate?: number;
  readonly voice?: string;
}

export interface LocalTtsVoiceInfo {
  readonly voiceId: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly source: "builtin" | "user";
  readonly createdAt: number;
  readonly refDurationMs: number;
  readonly language: string;
}

export type LocalTtsFrame =
  | { readonly kind: "ready"; readonly format: string; readonly sampleRate: number; readonly voice: string | null }
  | { readonly kind: "started"; readonly requestId: string }
  | {
      readonly kind: "done";
      readonly requestId: string;
      readonly ttfaMs: number;
      readonly rtf: number;
      readonly audioSeconds: number;
    }
  | { readonly kind: "warning"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "pong" }
  | { readonly kind: "voiceCreated"; readonly voiceId: string; readonly name: string; readonly createdAt: number }
  | { readonly kind: "voiceList"; readonly voices: readonly LocalTtsVoiceInfo[] }
  | { readonly kind: "voiceDeleted"; readonly voiceId: string }
  | { readonly kind: "audio"; readonly data: Uint8Array }
  | { readonly kind: "unknown"; readonly raw: unknown };

/**
 * Builds the connect-time negotiation URL (CONTRACT.md §1.1):
 * `<base>/?format=..&sample_rate=..&voice=..`. Absent opts are omitted from
 * the query string entirely (the service falls back to its configured
 * defaults) — never sent as empty/undefined params.
 */
export function buildConnectUrl(base: string, opts: LocalTtsConnectOptions = {}): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const params = new URLSearchParams();
  if (opts.format !== undefined) params.set("format", opts.format);
  if (opts.sampleRate !== undefined) params.set("sample_rate", String(opts.sampleRate));
  if (opts.voice !== undefined) params.set("voice", opts.voice);

  const query = params.toString();
  return query ? `${normalizedBase}/?${query}` : `${normalizedBase}/`;
}

export function textMsg(text: string): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.TEXT, text });
}

export function flushMsg(): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.FLUSH });
}

export function endMsg(): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.END });
}

export function cancelMsg(): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.CANCEL });
}

export function pingMsg(): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.PING });
}

/**
 * CONTRACT.md §4.1 — MUST be followed by exactly one binary WS frame (the
 * reference WAV) sent separately by the caller. Not part of this builder.
 * `description`/`tags`/`language` are optional on the wire (CONTRACT.md
 * §4.1) but required here — callers pass `""`/`[]`/`""` explicitly for a
 * bare-name pack.
 */
export function voiceCreateMsg(name: string, description: string, tags: readonly string[], language: string): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.VOICE_CREATE, name, description, tags, language });
}

/** CONTRACT.md §4.2. */
export function voiceListMsg(): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.VOICE_LIST });
}

/** CONTRACT.md §4.3. */
export function voiceDeleteMsg(voiceId: string): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.VOICE_DELETE, voiceId });
}

/**
 * Parses one server -> client WS message. Binary frames (`ArrayBuffer`) are
 * always audio (CONTRACT.md §5.1 — the only binary the server ever sends).
 * Text frames are JSON; an unrecognized `type`, non-object payload, or
 * malformed JSON degrades to `{kind:"unknown"}` rather than throwing — this
 * is a trusted local service (§1), but CONTRACT.md §8 notes the frame set
 * may grow, so forward-compat is a parse fallback, not an error path.
 */
export function parseServerFrame(data: string | ArrayBuffer): LocalTtsFrame {
  if (data instanceof ArrayBuffer) {
    return { kind: "audio", data: new Uint8Array(data) };
  }
  return parseJsonFrame(data);
}

/** The full `SERVER_MSG_TYPE` value union — keying `FRAME_PARSERS` on this (Fix 3) makes a
 *  new `SERVER_MSG_TYPE` entry without a matching parser a compile error, not a silent
 *  runtime fall-through to `unknown`. */
type ServerMsgType = (typeof SERVER_MSG_TYPE)[keyof typeof SERVER_MSG_TYPE];

/**
 * Returns `null` when a required field is absent or the wrong wire type —
 * never a frame with a fabricated/coerced value. The caller (`parseJsonFrame`)
 * turns a `null` result into `{kind:"unknown"}`.
 */
type FrameParser = (record: Record<string, unknown>) => LocalTtsFrame | null;

const FRAME_PARSERS: Record<ServerMsgType, FrameParser> = {
  [SERVER_MSG_TYPE.READY]: parseReadyFrame,
  [SERVER_MSG_TYPE.STARTED]: parseStartedFrame,
  [SERVER_MSG_TYPE.DONE]: parseDoneFrame,
  [SERVER_MSG_TYPE.WARNING]: (r) => parseReasonFrame("warning", r),
  [SERVER_MSG_TYPE.ERROR]: (r) => parseReasonFrame("error", r),
  [SERVER_MSG_TYPE.PONG]: () => ({ kind: "pong" }),
  [SERVER_MSG_TYPE.VOICE_CREATED]: parseVoiceCreatedFrame,
  [SERVER_MSG_TYPE.VOICE_LIST]: parseVoiceListFrame,
  [SERVER_MSG_TYPE.VOICE_DELETED]: parseVoiceDeletedFrame,
};

function parseJsonFrame(text: string): LocalTtsFrame {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { kind: "unknown", raw: text };
  }
  if (!msg || typeof msg !== "object") return { kind: "unknown", raw: msg };

  const record = msg as Record<string, unknown>;
  const { type } = record;
  // Object.hasOwn guards a plain-object lookup table against a server-supplied `type`
  // of "__proto__" (resolves to Object.prototype — truthy, non-function, throws when
  // called) or "constructor"/"toString" (resolve to real inherited functions) (Fix 2).
  if (typeof type !== "string" || !Object.hasOwn(FRAME_PARSERS, type)) {
    return { kind: "unknown", raw: record };
  }
  const parsed = FRAME_PARSERS[type as ServerMsgType](record);
  return parsed ?? { kind: "unknown", raw: record };
}

function parseReadyFrame(record: Record<string, unknown>): LocalTtsFrame | null {
  const format = requireString(record.format);
  const sampleRate = requireNumber(record.sample_rate);
  if (format === undefined || sampleRate === undefined) return null;
  return {
    kind: "ready",
    format,
    sampleRate,
    voice: typeof record.voice === "string" ? record.voice : null,
  };
}

function parseStartedFrame(record: Record<string, unknown>): LocalTtsFrame | null {
  const requestId = requireString(record.requestId);
  return requestId === undefined ? null : { kind: "started", requestId };
}

function parseDoneFrame(record: Record<string, unknown>): LocalTtsFrame | null {
  const requestId = requireString(record.requestId);
  const ttfaMs = requireNumber(record.ttfa_ms);
  const rtf = requireNumber(record.rtf);
  const audioSeconds = requireNumber(record.audio_seconds);
  if (requestId === undefined || ttfaMs === undefined || rtf === undefined || audioSeconds === undefined) {
    return null;
  }
  return { kind: "done", requestId, ttfaMs, rtf, audioSeconds };
}

function parseReasonFrame(kind: "warning" | "error", record: Record<string, unknown>): LocalTtsFrame | null {
  const reason = requireString(record.reason);
  return reason === undefined ? null : { kind, reason };
}

function parseVoiceCreatedFrame(record: Record<string, unknown>): LocalTtsFrame | null {
  const voiceId = requireString(record.voiceId);
  const name = requireString(record.name);
  if (voiceId === undefined || name === undefined) return null;
  return { kind: "voiceCreated", voiceId, name, createdAt: asNumber(record.createdAt) };
}

function parseVoiceDeletedFrame(record: Record<string, unknown>): LocalTtsFrame | null {
  const voiceId = requireString(record.voiceId);
  return voiceId === undefined ? null : { kind: "voiceDeleted", voiceId };
}

function parseVoiceListFrame(record: Record<string, unknown>): LocalTtsFrame | null {
  if (!Array.isArray(record.voices)) return null;
  const voices: LocalTtsVoiceInfo[] = [];
  for (const entry of record.voices) {
    const info = parseVoiceInfo(entry);
    if (info) voices.push(info);
  }
  return { kind: "voiceList", voices };
}

/** `description`/`tags`/`source`/`language` are defensively defaulted (never required)
 *  so a legacy pack predating Task 1 (CONTRACT.md §4.2) or a pack predating the
 *  `language` field still parses instead of degrading the whole frame to `unknown`. */
function parseVoiceInfo(entry: unknown): LocalTtsVoiceInfo | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const voiceId = requireString(record.voiceId);
  const name = requireString(record.name);
  if (voiceId === undefined || name === undefined) return null;
  return {
    voiceId,
    name,
    description: typeof record.description === "string" ? record.description : "",
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
    source: record.source === "builtin" ? "builtin" : "user",
    createdAt: asNumber(record.createdAt),
    refDurationMs: asNumber(record.refDurationMs),
    language: typeof record.language === "string" ? record.language : "",
  };
}

/** Optional-field default: absent/wrong-typed -> 0. Never use for a field CONTRACT.md
 *  marks required — see `requireNumber`. */
function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

/** Required-field validator: absent/wrong-typed -> `undefined`, signaling the caller to
 *  degrade the whole frame to `{kind:"unknown"}` rather than fabricate a value. Never
 *  defaults — in particular, never fabricates an id (see module-level id-correlation
 *  contract for `requestId`/`voiceId`). */
function requireString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Required-field validator: absent/wrong-typed -> `undefined`. See `requireString`. */
function requireNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
