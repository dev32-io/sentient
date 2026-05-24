import { z } from "zod";
import { contentBlockSchema } from "./content-blocks.js";

// ---------------------------------------------------------------------------
// session/update notification payloads — discriminated by `update.sessionUpdate`.
// Translator (T4.4) narrows on this field. Unknown `sessionUpdate` literals
// from the agent (e.g. plan, mode_change) are NOT a parse error at the
// envelope layer — the translator routes them as "ignored / log + skip"
// until we wire them.
//
// `content` on chunk variants is a single discriminated ContentBlock per
// upstream `ContentChunk` (see ./content-blocks.ts) — NOT a bare string or
// array.
// ---------------------------------------------------------------------------

const metaSchema = z.record(z.unknown()).optional();

export const agentMessageChunkSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("agent_message_chunk"),
    content: contentBlockSchema,
    messageId: z.string().optional(),
    _meta: metaSchema,
  }),
  _meta: metaSchema,
});
export type AgentMessageChunkUpdate = z.infer<typeof agentMessageChunkSchema>;

// Probe finding: Hermes emits agent_thought_chunk for narrator status text
// (`( •_•)>⌐■-■ ruminating...`). Original plan omitted this variant.
export const agentThoughtChunkSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("agent_thought_chunk"),
    content: contentBlockSchema,
    messageId: z.string().optional(),
    _meta: metaSchema,
  }),
  _meta: metaSchema,
});
export type AgentThoughtChunkUpdate = z.infer<typeof agentThoughtChunkSchema>;

export const toolCallStatusSchema = z.union([
  z.literal("pending"),
  z.literal("in_progress"),
  z.literal("completed"),
  z.literal("failed"),
]);
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;

// Upstream `ToolCall`: title is REQUIRED (no default). The *update* variant
// (toolCallUpdateSchema below) keeps it optional, matching `ToolCallUpdate`.
export const toolCallSchema = z.object({
  sessionId: z.string(),
  update: z
    .object({
      sessionUpdate: z.literal("tool_call"),
      toolCallId: z.string(),
      title: z.string(),
      kind: z.string().optional(),
      status: toolCallStatusSchema.optional(),
      rawInput: z.unknown().optional(),
      _meta: metaSchema,
    })
    .passthrough(),
  _meta: metaSchema,
});
export type ToolCallUpdate = z.infer<typeof toolCallSchema>;

export const toolCallUpdateSchema = z.object({
  sessionId: z.string(),
  update: z
    .object({
      sessionUpdate: z.literal("tool_call_update"),
      toolCallId: z.string(),
      title: z.string().optional(),
      status: toolCallStatusSchema.optional(),
      rawOutput: z.unknown().optional(),
      content: z.array(z.unknown()).optional(),
      _meta: metaSchema,
    })
    .passthrough(),
  _meta: metaSchema,
});
export type ToolCallProgressUpdate = z.infer<typeof toolCallUpdateSchema>;

export const sessionInfoUpdateSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("session_info_update"),
    title: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    _meta: metaSchema,
  }),
  _meta: metaSchema,
});
export type SessionInfoUpdate = z.infer<typeof sessionInfoUpdateSchema>;

export const availableCommandsUpdateSchema = z.object({
  sessionId: z.string(),
  update: z.object({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: z.array(z.unknown()),
    _meta: metaSchema,
  }),
  _meta: metaSchema,
});
export type AvailableCommandsUpdate = z.infer<typeof availableCommandsUpdateSchema>;

/**
 * Discriminated union of all `session/update` notification payloads we care
 * about today.
 */
export const sessionUpdateParamsSchema = z.union([
  agentMessageChunkSchema,
  agentThoughtChunkSchema,
  toolCallSchema,
  toolCallUpdateSchema,
  sessionInfoUpdateSchema,
  availableCommandsUpdateSchema,
]);
export type SessionUpdateParams = z.infer<typeof sessionUpdateParamsSchema>;
