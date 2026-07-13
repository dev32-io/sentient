// ---------------------------------------------------------------------------
// local-tts-protocol — WS message codec for the native ChatterboxTTSService.
//
// Wire contract: capabilityServices/ChatterboxTTSService/CONTRACT.md. Unlike
// Fish Audio (MessagePack, see fish-audio-protocol.ts), this service speaks
// JSON text frames for control messages and raw binary frames for audio —
// no MessagePack.
//
// The service's JSON field names are a mix of camelCase (`requestId`,
// `voiceId`, `createdAt`) and snake_case (`sample_rate`, `ttfa_ms`,
// `audio_seconds`) — CONTRACT.md is the source of truth for exactly which.
// Builders emit the wire shape verbatim; parseServerFrame normalizes every
// parsed frame to camelCase fields, matching this codebase's TS convention
// (see TTSAudioChunk.sampleRate in tts-types.ts).
// ---------------------------------------------------------------------------

/** Client -> server JSON message `type` values (CONTRACT.md §3.1). */
const CLIENT_MSG_TYPE = {
  TEXT: "text",
  FLUSH: "flush",
  END: "end",
  CANCEL: "cancel",
  PING: "ping",
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
  readonly createdAt: number;
  readonly refDurationMs: number;
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

type FrameParser = (record: Record<string, unknown>) => LocalTtsFrame;

const FRAME_PARSERS: Record<string, FrameParser> = {
  [SERVER_MSG_TYPE.READY]: parseReadyFrame,
  [SERVER_MSG_TYPE.STARTED]: (r) => ({ kind: "started", requestId: asString(r.requestId) }),
  [SERVER_MSG_TYPE.DONE]: parseDoneFrame,
  [SERVER_MSG_TYPE.WARNING]: (r) => ({ kind: "warning", reason: asString(r.reason) }),
  [SERVER_MSG_TYPE.ERROR]: (r) => ({ kind: "error", reason: asString(r.reason) }),
  [SERVER_MSG_TYPE.PONG]: () => ({ kind: "pong" }),
  [SERVER_MSG_TYPE.VOICE_CREATED]: parseVoiceCreatedFrame,
  [SERVER_MSG_TYPE.VOICE_LIST]: parseVoiceListFrame,
  [SERVER_MSG_TYPE.VOICE_DELETED]: (r) => ({ kind: "voiceDeleted", voiceId: asString(r.voiceId) }),
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
  const parser = typeof record.type === "string" ? FRAME_PARSERS[record.type] : undefined;
  return parser ? parser(record) : { kind: "unknown", raw: record };
}

function parseReadyFrame(record: Record<string, unknown>): LocalTtsFrame {
  return {
    kind: "ready",
    format: asString(record.format),
    sampleRate: asNumber(record.sample_rate),
    voice: typeof record.voice === "string" ? record.voice : null,
  };
}

function parseDoneFrame(record: Record<string, unknown>): LocalTtsFrame {
  return {
    kind: "done",
    requestId: asString(record.requestId),
    ttfaMs: asNumber(record.ttfa_ms),
    rtf: asNumber(record.rtf),
    audioSeconds: asNumber(record.audio_seconds),
  };
}

function parseVoiceCreatedFrame(record: Record<string, unknown>): LocalTtsFrame {
  return {
    kind: "voiceCreated",
    voiceId: asString(record.voiceId),
    name: asString(record.name),
    createdAt: asNumber(record.createdAt),
  };
}

function parseVoiceListFrame(record: Record<string, unknown>): LocalTtsFrame {
  const rawVoices = Array.isArray(record.voices) ? record.voices : [];
  return { kind: "voiceList", voices: rawVoices.map(parseVoiceInfo) };
}

function parseVoiceInfo(entry: unknown): LocalTtsVoiceInfo {
  const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  return {
    voiceId: asString(record.voiceId),
    name: asString(record.name),
    createdAt: asNumber(record.createdAt),
    refDurationMs: asNumber(record.refDurationMs),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
