import type { VoiceOpError } from "../../providers/tts/voice-mgmt-client.js";

// ---------------------------------------------------------------------------
// Shared HTTP status constants + VoiceOpError -> Response mapping for the
// voices REST surface. Split out of voices.ts so voices.ts and
// voices-preview.ts can both depend on it without a circular import between
// the two handler modules (voices.ts routes to voices-preview.ts; both need
// this error mapping).
// ---------------------------------------------------------------------------

export const HTTP_OK = 200;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_NOT_FOUND = 404;
export const HTTP_METHOD = 405;
export const HTTP_UNPROCESSABLE = 422;
export const HTTP_CONFLICT = 409;
export const HTTP_BAD_GATEWAY = 502;
export const HTTP_TIMEOUT = 504;

// The service's voice.delete rejection reason for a protected built-in pack
// (CONTRACT.md) — the one service-error that is a client/state conflict
// (409) rather than a generic unprocessable request (422).
const BUILTIN_VOICE_REASON = "builtin-voice";

export function mapVoiceOpError(error: VoiceOpError): Response {
  switch (error.kind) {
    case "service-error":
      if (error.reason === BUILTIN_VOICE_REASON) return jsonError(HTTP_CONFLICT, BUILTIN_VOICE_REASON);
      return Response.json({ error: "voice-op-failed", reason: error.reason }, { status: HTTP_UNPROCESSABLE });
    case "timeout":
      return jsonError(HTTP_TIMEOUT, "voice-op-timeout");
    case "transport":
      return jsonError(HTTP_BAD_GATEWAY, "tts-unreachable");
    default:
      return assertNever(error);
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

export function jsonError(status: number, code: string, reason?: string): Response {
  return Response.json(reason !== undefined ? { error: code, reason } : { error: code }, { status });
}
