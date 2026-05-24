import { z } from "zod";

// ---------------------------------------------------------------------------
// ACP method-specific schemas — mirrors upstream `acp/schema.py` (v0.11.2).
// `_meta` permissive per upstream extensibility annotation; result objects
// `.passthrough()` so upstream additions don't break parsing.
//
// Wire-shape corrections vs. original ACP-pivot plan:
//   - `initialize` REQUIRES `protocolVersion: 1` (plan sample omitted it).
//   - cancel uses `session/cancel` NOTIFICATION with `{sessionId}`,
//     NOT LSP-style `$/cancelRequest`.
//
// Required-field corrections vs. earlier draft (verified against upstream
// pydantic models):
//   - SessionInfo.cwd, NewSessionRequest.{cwd,mcpServers},
//     LoadSessionRequest.{cwd,mcpServers}, ToolCall.title — all REQUIRED.
//   - ContentChunk.content is a SINGLE discriminated content block, not a
//     bare string or array (see ./content-blocks.ts).
//
// session/update notification payloads live in ./session-updates.ts and are
// re-exported below for consumer convenience.

export * from "./session-updates.js";

/** ACP protocol version this adapter targets (matches upstream PROTOCOL_VERSION). */
export const ACP_PROTOCOL_VERSION = 1 as const;

/** Upstream pydantic constraint: `ge=0, le=65535` on protocolVersion. */
const PROTOCOL_VERSION_MIN = 0;
const PROTOCOL_VERSION_MAX = 65535;

const metaSchema = z.record(z.unknown()).optional();

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export const clientCapabilitiesSchema = z
  .object({
    sessionList: z.boolean().optional(),
  })
  .passthrough();

export const initializeParamsSchema = z.object({
  protocolVersion: z.literal(ACP_PROTOCOL_VERSION),
  clientCapabilities: clientCapabilitiesSchema,
  _meta: metaSchema,
});
export type InitializeParams = z.infer<typeof initializeParamsSchema>;

export const initializeResultSchema = z
  .object({
    protocolVersion: z.number().int().min(PROTOCOL_VERSION_MIN).max(PROTOCOL_VERSION_MAX),
    agentCapabilities: z.unknown().optional(),
    agentInfo: z.unknown().optional(),
    authMethods: z.array(z.unknown()).optional(),
    _meta: metaSchema,
  })
  .passthrough();
export type InitializeResult = z.infer<typeof initializeResultSchema>;

// ---------------------------------------------------------------------------
// session/new + session/load
// ---------------------------------------------------------------------------

// Operator-supplied MCP server descriptor. Upstream defines three concrete
// shapes (HttpMcpServer, SseMcpServer, McpServerStdio); the gateway hands the
// raw record straight through to Hermes, so we keep this loose at the adapter
// edge.
export const mcpServerSchema = z.record(z.unknown());
export type McpServer = z.infer<typeof mcpServerSchema>;

// Upstream `NewSessionRequest`: cwd + mcpServers are BOTH required (no default
// on either). Empty-array mcpServers is fine; the field must be present.
export const sessionNewParamsSchema = z.object({
  cwd: z.string(),
  mcpServers: z.array(mcpServerSchema),
  _meta: metaSchema,
});
export type SessionNewParams = z.infer<typeof sessionNewParamsSchema>;

export const sessionNewResultSchema = z
  .object({
    sessionId: z.string(),
    modes: z.array(z.unknown()).optional(),
    _meta: metaSchema,
  })
  .passthrough();
export type SessionNewResult = z.infer<typeof sessionNewResultSchema>;

// Upstream `LoadSessionRequest`: cwd + mcpServers BOTH required, same as new.
export const sessionLoadParamsSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  mcpServers: z.array(mcpServerSchema),
  _meta: metaSchema,
});
export type SessionLoadParams = z.infer<typeof sessionLoadParamsSchema>;

// ---------------------------------------------------------------------------
// session/list
// ---------------------------------------------------------------------------

// Upstream `SessionInfo`: cwd is REQUIRED ("Must be an absolute path"). Hermes
// always returns a value here for rows in `session/list`. The translator maps
// these rows directly to `SessionRow` — no per-row enrichment.
export const sessionListSessionInfoSchema = z
  .object({
    sessionId: z.string(),
    title: z.string().nullable().optional(),
    cwd: z.string(),
    updatedAt: z.string().nullable().optional(),
    _meta: metaSchema,
  })
  .passthrough();
export type SessionListSessionInfo = z.infer<typeof sessionListSessionInfoSchema>;

export const sessionListParamsSchema = z.object({
  cwd: z.string().optional(),
  cursor: z.string().optional(),
  _meta: metaSchema,
});
export type SessionListParams = z.infer<typeof sessionListParamsSchema>;

export const sessionListResultSchema = z
  .object({
    sessions: z.array(sessionListSessionInfoSchema),
    nextCursor: z.string().nullable().optional(),
    _meta: metaSchema,
  })
  .passthrough();
export type SessionListResult = z.infer<typeof sessionListResultSchema>;

// ---------------------------------------------------------------------------
// session/prompt
// ---------------------------------------------------------------------------

// The full ACP ContentBlock union covers text, image, audio, resource_link,
// and embedded resource. The gateway only sends text + image to Hermes today.
// Keeping the discriminated union narrow at this layer; the translator can
// widen on demand.
export const promptContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    _meta: metaSchema,
  }),
  z.object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
    _meta: metaSchema,
  }),
]);
export type PromptContentPart = z.infer<typeof promptContentPartSchema>;

export const sessionPromptParamsSchema = z.object({
  sessionId: z.string(),
  prompt: z.array(promptContentPartSchema),
  _meta: metaSchema,
});
export type SessionPromptParams = z.infer<typeof sessionPromptParamsSchema>;

// Upstream StopReason literal: end_turn | max_tokens | max_turn_requests |
// refusal | cancelled. Pin to the upstream set — no string fallback. If
// upstream adds a variant, fail loud and update this union.
export const stopReasonSchema = z.union([
  z.literal("end_turn"),
  z.literal("cancelled"),
  z.literal("max_tokens"),
  z.literal("max_turn_requests"),
  z.literal("refusal"),
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

export const sessionPromptResultSchema = z
  .object({
    stopReason: stopReasonSchema,
    usage: z.record(z.unknown()).optional(),
    _meta: metaSchema,
  })
  .passthrough();
export type SessionPromptResult = z.infer<typeof sessionPromptResultSchema>;

// ---------------------------------------------------------------------------
// session/cancel  (NOTIFICATION — agent does not reply)
// ---------------------------------------------------------------------------
// Wire shape per upstream `CancelNotification`. NOT LSP-style
// `$/cancelRequest`: that would need a `requestId` and is a different
// notification (`CancelRequestNotification`). We do not use it.

export const sessionCancelParamsSchema = z.object({
  sessionId: z.string(),
  _meta: metaSchema,
});
export type SessionCancelParams = z.infer<typeof sessionCancelParamsSchema>;
