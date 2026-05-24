// SDK-Gateway Contract — Message types, validation, and protocol rules
// Replicates the real codebase's Zod-validated message schemas + proposed v2 additions

import { z } from "zod";

// ─── Error Codes (validated enum, not free-form string) ───

export const ERROR_CODES = [
  "auth_failed",
  "session_limit",
  "token_expired",
  "protocol_error",
  "provider_error",
  "utterance_failed",
  "unsupported_config",
  "rate_limited",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// ─── Client → Gateway Messages ───

export const utteranceStartSchema = z.object({
  type: z.literal("utterance.start"),
  utteranceId: z.string().uuid(),
});

export const utteranceEndSchema = z.object({
  type: z.literal("utterance.end"),
  utteranceId: z.string().uuid(),
});

export const sessionConfigureSchema = z.object({
  type: z.literal("session.configure"),
  mode: z.enum(["continuous", "push-to-talk"]),
  encoding: z.enum(["pcm16", "opus"]),
  sampleRate: z.number().int().positive(),
  capabilities: z.array(z.string()),
});

export const bargeInClientSchema = z.object({
  type: z.literal("barge_in"),
  responseId: z.string().uuid(),
});

export const sessionEndRequestSchema = z.object({
  type: z.literal("session.end"),
});

export const pingSchema = z.object({
  type: z.literal("ping"),
});

export const textInputSchema = z.object({
  type: z.literal("text.input"),
  text: z.string().min(1).max(10000),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  utteranceStartSchema,
  utteranceEndSchema,
  sessionConfigureSchema,
  bargeInClientSchema,
  sessionEndRequestSchema,
  pingSchema,
  textInputSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ─── Gateway → Client Messages ───

export const sessionCreatedSchema = z.object({
  type: z.literal("session.created"),
  sessionId: z.string(),
  protocol: z.string(),
});

export const sessionReadySchema = z.object({
  type: z.literal("session.ready"),
  encoding: z.enum(["pcm16", "opus"]),
  sampleRate: z.number().int().positive(),
});

export const transcriptPartialSchema = z.object({
  type: z.literal("transcript.partial"),
  utteranceId: z.string().uuid(),
  text: z.string(),
});

export const transcriptFinalSchema = z.object({
  type: z.literal("transcript.final"),
  utteranceId: z.string().uuid(),
  text: z.string(),
});

export const responseStartSchema = z.object({
  type: z.literal("response.start"),
  utteranceId: z.string().uuid(),
  responseId: z.string().uuid(),
});

export const responseTextDeltaSchema = z.object({
  type: z.literal("response.text.delta"),
  responseId: z.string().uuid(),
  text: z.string(),
});

export const responseTextDoneSchema = z.object({
  type: z.literal("response.text.done"),
  responseId: z.string().uuid(),
  text: z.string(),
});

export const responseAudioStartSchema = z.object({
  type: z.literal("response.audio.start"),
  responseId: z.string().uuid(),
});

export const responseAudioDoneSchema = z.object({
  type: z.literal("response.audio.done"),
  responseId: z.string().uuid(),
});

export const responseDoneSchema = z.object({
  type: z.literal("response.done"),
  responseId: z.string().uuid(),
});

export const bargeInAckSchema = z.object({
  type: z.literal("barge_in.ack"),
  responseId: z.string().uuid(),
  truncatedText: z.string(),
});

export const contractErrorSchema = z.object({
  type: z.literal("error"),
  code: z.enum(ERROR_CODES),
  message: z.string(),
  utteranceId: z.string().uuid().optional(),
  responseId: z.string().uuid().optional(),
  recoverable: z.boolean(),
});

export const pongSchema = z.object({
  type: z.literal("pong"),
});

export const sessionEndedSchema = z.object({
  type: z.literal("session.ended"),
  reason: z.enum(["client_request", "timeout", "error"]),
});

export const gatewayMessageSchema = z.discriminatedUnion("type", [
  sessionCreatedSchema,
  sessionReadySchema,
  transcriptPartialSchema,
  transcriptFinalSchema,
  responseStartSchema,
  responseTextDeltaSchema,
  responseTextDoneSchema,
  responseAudioStartSchema,
  responseAudioDoneSchema,
  responseDoneSchema,
  bargeInAckSchema,
  contractErrorSchema,
  pongSchema,
  sessionEndedSchema,
]);

export type GatewayMessage = z.infer<typeof gatewayMessageSchema>;

// ─── Binary/JSON Mux ───

export type WsMessageType = "text" | "binary";

export interface WireMessage {
  wsType: WsMessageType;
  data: string | Uint8Array;
}

export function encodeClientMessage(msg: ClientMessage): WireMessage {
  return { wsType: "text", data: JSON.stringify(msg) };
}

export function encodeAudioChunk(pcm: Uint8Array): WireMessage {
  return { wsType: "binary", data: pcm };
}

export function decodeWireMessage(wire: WireMessage): GatewayMessage | Uint8Array {
  if (wire.wsType === "binary") {
    return wire.data as Uint8Array;
  }
  const parsed = JSON.parse(wire.data as string);
  return gatewayMessageSchema.parse(parsed);
}

export function decodeClientWireMessage(wire: WireMessage): ClientMessage | Uint8Array {
  if (wire.wsType === "binary") {
    return wire.data as Uint8Array;
  }
  const parsed = JSON.parse(wire.data as string);
  return clientMessageSchema.parse(parsed);
}

// ─── Protocol Sequence Validator ───
// Validates that messages arrive in legal order per the contract

export type ProtocolPhase =
  | "connected"       // WS open, awaiting session.created
  | "created"         // Got session.created, client sends session.configure
  | "configured"      // Client configured, awaiting session.ready
  | "ready"           // Session ready, can stream
  | "streaming"       // Active utterance in progress
  | "awaiting_result" // utterance.end sent, awaiting transcript/response
  | "responding"      // Response streaming
  | "ended";          // Session over

export interface ProtocolValidator {
  phase: ProtocolPhase;
  activeUtteranceId: string | null;
  activeResponseId: string | null;
  errors: string[];
  feed(msg: ClientMessage | GatewayMessage): void;
  feedBinary(direction: "client" | "gateway"): void;
}

export function createProtocolValidator(): ProtocolValidator {
  const validator: ProtocolValidator = {
    phase: "connected",
    activeUtteranceId: null,
    activeResponseId: null,
    errors: [],

    feed(msg) {
      const err = (m: string) => validator.errors.push(`[${validator.phase}] ${m}`);

      switch (msg.type) {
        case "session.created":
          if (validator.phase !== "connected") {
            err("session.created received outside 'connected' phase");
          }
          validator.phase = "created";
          break;

        case "session.configure":
          if (validator.phase !== "created") {
            err("session.configure sent outside 'created' phase");
          }
          validator.phase = "configured";
          break;

        case "session.ready":
          if (validator.phase !== "configured") {
            err("session.ready received outside 'configured' phase");
          }
          validator.phase = "ready";
          break;

        case "utterance.start":
          if (validator.phase !== "ready" && validator.phase !== "responding") {
            err(`utterance.start in invalid phase: ${validator.phase}`);
          }
          if (validator.activeUtteranceId) {
            err(`utterance.start while utterance ${validator.activeUtteranceId} still active`);
          }
          validator.activeUtteranceId = msg.utteranceId;
          validator.phase = "streaming";
          break;

        case "utterance.end":
          if (validator.phase !== "streaming") {
            err("utterance.end outside 'streaming' phase");
          }
          if (msg.utteranceId !== validator.activeUtteranceId) {
            err(`utterance.end ID mismatch: ${msg.utteranceId} vs ${validator.activeUtteranceId}`);
          }
          validator.phase = "awaiting_result";
          break;

        case "transcript.partial":
          if (validator.phase !== "streaming" && validator.phase !== "awaiting_result") {
            err("transcript.partial in invalid phase");
          }
          break;

        case "transcript.final":
          if (validator.phase !== "awaiting_result" && validator.phase !== "streaming") {
            err("transcript.final in invalid phase");
          }
          break;

        case "response.start":
          if (validator.phase !== "awaiting_result") {
            err("response.start outside 'awaiting_result' phase");
          }
          validator.activeResponseId = (msg as z.infer<typeof responseStartSchema>).responseId;
          validator.activeUtteranceId = null;
          validator.phase = "responding";
          break;

        case "response.text.delta":
        case "response.audio.start":
        case "response.audio.done":
        case "response.text.done":
          if (validator.phase !== "responding") {
            err(`${msg.type} outside 'responding' phase`);
          }
          break;

        case "response.done":
          if (validator.phase !== "responding") {
            err("response.done outside 'responding' phase");
          }
          validator.activeResponseId = null;
          validator.phase = "ready";
          break;

        case "barge_in":
          if (validator.phase !== "responding") {
            err("barge_in outside 'responding' phase");
          }
          break;

        case "barge_in.ack":
          if (validator.phase !== "responding") {
            err("barge_in.ack outside 'responding' phase");
          }
          validator.activeResponseId = null;
          validator.phase = "ready";
          break;

        case "session.end":
          validator.phase = "ended";
          break;

        case "session.ended":
          validator.phase = "ended";
          break;

        case "ping":
        case "pong":
          break; // valid in any phase

        case "error":
          // errors can arrive in any phase
          break;

        case "text.input":
          if (validator.phase !== "ready") {
            err("text.input outside 'ready' phase");
          }
          break;
      }
    },

    feedBinary(direction) {
      if (direction === "client" && validator.phase !== "streaming") {
        validator.errors.push(`[${validator.phase}] client binary audio outside 'streaming' phase`);
      }
      if (direction === "gateway" && validator.phase !== "responding") {
        validator.errors.push(`[${validator.phase}] gateway binary audio outside 'responding' phase`);
      }
    },
  };

  return validator;
}

// ─── Mock Transport (replaces real WebSocket for testing) ───

export interface MockTransport {
  clientSent: WireMessage[];
  gatewaySent: WireMessage[];
  clientSend(msg: WireMessage): void;
  gatewaySend(msg: WireMessage): void;
  onClientMessage?: (msg: WireMessage) => void;
  onGatewayMessage?: (msg: WireMessage) => void;
}

export function createMockTransport(): MockTransport {
  const transport: MockTransport = {
    clientSent: [],
    gatewaySent: [],

    clientSend(msg) {
      transport.clientSent.push(msg);
      transport.onClientMessage?.(msg);
    },

    gatewaySend(msg) {
      transport.gatewaySent.push(msg);
      transport.onGatewayMessage?.(msg);
    },
  };
  return transport;
}
