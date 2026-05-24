import { z } from "zod";
import { getLog } from "../logging/logger.js";
import {
  agentMessageChunkSchema,
  agentThoughtChunkSchema,
  availableCommandsUpdateSchema,
  sessionInfoUpdateSchema,
  toolCallSchema,
  toolCallUpdateSchema,
} from "./session-updates.js";

const log = getLog(["sentient", "hermes-adapter-client", "acp", "event-translator"]);

/**
 * ACP `session/update` notification translator. ONLY place that knows ACP wire
 * shapes. Validates `unknown` via zod schemas (`./session-updates.ts`) BEFORE
 * field access; schema failure → log + `[]` (forward-compat: tolerate shape
 * drift). `agent_thought_chunk` silently dropped — narrator status text.
 *
 * SCOPE: `session/update` only. The cycle-end signal (the old custom-WS
 * `completed` HermesEvent) is NOT a notification — T4.5's
 * `per-profile-connection.ts` synthesizes `cycle.done` from the `session/prompt`
 * JSON-RPC response, not here.
 * INTENTIONAL DIVERGENCE FROM `../event-translator.ts`: ACP is richer than the
 * custom-WS `HermesEvent` union, so `InternalEvent` is broader. T4.5
 * per-profile-connection adapts to existing consumer surfaces:
 *   - `assistant.message` → ConversationMirror append (ACP sends complete text block per chunk; WS chunked deltas).
 *   - `tool.started/progress/finished` → TaskMirror (progress is new vs WS).
 *   - `sessions.renamed` / `commands.available` → SDK events, BYPASS cerebrum.
 */

/** Cap for stringified previews in tool.started.argsPreview / tool.finished.summary. */
const PREVIEW_MAX_CHARS = 120;

/** UI-facing slash commands we expose. Synthesized rows are added regardless of upstream. */
const SYNTHESIZED_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "personality", description: "Edit your assistant's persona (SOUL.md)" },
  { name: "new", description: "Start a new chat" },
  { name: "skills", description: "Browse available skills" },
];

/** Upstream → gateway slash-command renames. Direct passthroughs are not listed. */
const COMMAND_RENAMES: ReadonlyMap<string, string> = new Map([["reset", "clear"]]);

/** Upstream commands the gateway UI does not expose. */
const DROPPED_COMMANDS: ReadonlySet<string> = new Set(["help", "tools", "context", "compact", "version"]);

/** Upstream commands kept under their original name. */
const PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set(["model"]);

export type InternalEvent =
  | { type: "assistant.message"; text: string }
  | { type: "tool.started"; callId: string; toolName: string; argsPreview: string }
  | { type: "tool.progress"; callId: string; message: string }
  | { type: "tool.finished"; callId: string; status: "ok" | "failed"; summary: string }
  | { type: "sessions.renamed"; sessionId: string; title: string; source: "auto" | "user" }
  | {
      type: "commands.available";
      commands: ReadonlyArray<{ name: string; description?: string }>;
    };

/**
 * Translate one ACP `session/update` notification payload into 0..N internal
 * events. Returns `[]` for: validation failures, unknown discriminators,
 * dropped variants (image content, agent_thought_chunk, pending tool status,
 * cleared title).
 */
export function translateSessionUpdate(notification: unknown): InternalEvent[] {
  const discriminator = readDiscriminator(notification);
  if (discriminator === undefined) {
    log.warn("schema-validation-failed", { reason: "missing-sessionUpdate-discriminator" });
    return [];
  }

  switch (discriminator) {
    case "agent_message_chunk":
      return translateAgentMessageChunk(notification);
    case "agent_thought_chunk":
      return translateAgentThoughtChunk(notification);
    case "tool_call":
      return translateToolCall(notification);
    case "tool_call_update":
      return translateToolCallUpdate(notification);
    case "session_info_update":
      return translateSessionInfoUpdate(notification);
    case "available_commands_update":
      return translateAvailableCommandsUpdate(notification);
    default:
      log.warn("unknown-session-update", { sessionUpdate: discriminator });
      return [];
  }
}

function readDiscriminator(notification: unknown): string | undefined {
  if (typeof notification !== "object" || notification === null) return undefined;
  const update = (notification as { update?: unknown }).update;
  if (typeof update !== "object" || update === null) return undefined;
  const value = (update as { sessionUpdate?: unknown }).sessionUpdate;
  return typeof value === "string" ? value : undefined;
}

function translateAgentMessageChunk(notification: unknown): InternalEvent[] {
  const parsed = agentMessageChunkSchema.safeParse(notification);
  if (!parsed.success) {
    log.warn("schema-validation-failed", {
      sessionUpdate: "agent_message_chunk",
      issues: parsed.error.issues.length,
    });
    return [];
  }
  const { content } = parsed.data.update;
  if (content.type !== "text") {
    log.debug("translate.agent-message-chunk.skipped-non-text", { contentType: content.type });
    return [];
  }
  log.debug("translate.agent-message-chunk", { textLen: content.text.length });
  return [{ type: "assistant.message", text: content.text }];
}

function translateAgentThoughtChunk(notification: unknown): InternalEvent[] {
  const parsed = agentThoughtChunkSchema.safeParse(notification);
  if (!parsed.success) {
    log.warn("schema-validation-failed", {
      sessionUpdate: "agent_thought_chunk",
      issues: parsed.error.issues.length,
    });
    return [];
  }
  // See file header — narrator status text intentionally not surfaced.
  log.debug("translate.agent-thought-chunk.dropped");
  return [];
}

function translateToolCall(notification: unknown): InternalEvent[] {
  const parsed = toolCallSchema.safeParse(notification);
  if (!parsed.success) {
    log.warn("schema-validation-failed", {
      sessionUpdate: "tool_call",
      issues: parsed.error.issues.length,
    });
    return [];
  }
  const { toolCallId, title, rawInput } = parsed.data.update;
  const argsPreview = previewValue(rawInput);
  log.debug("translate.tool-call", { callId: toolCallId, toolName: title });
  return [{ type: "tool.started", callId: toolCallId, toolName: title, argsPreview }];
}

function translateToolCallUpdate(notification: unknown): InternalEvent[] {
  const parsed = toolCallUpdateSchema.safeParse(notification);
  if (!parsed.success) {
    log.warn("schema-validation-failed", {
      sessionUpdate: "tool_call_update",
      issues: parsed.error.issues.length,
    });
    return [];
  }
  const { toolCallId, status, rawOutput, content } = parsed.data.update;

  if (status === "in_progress") {
    const message = extractProgressMessage(content);
    log.debug("translate.tool-call-update.in-progress", { callId: toolCallId, hasMessage: message !== undefined });
    return [{ type: "tool.progress", callId: toolCallId, message: message ?? "" }];
  }

  if (status === "completed" || status === "failed") {
    const summary = previewValue(rawOutput);
    log.debug("translate.tool-call-update.terminal", { callId: toolCallId, status });
    return [
      {
        type: "tool.finished",
        callId: toolCallId,
        status: status === "completed" ? "ok" : "failed",
        summary,
      },
    ];
  }

  // status === "pending" or undefined → no-op for us.
  log.debug("translate.tool-call-update.skipped", { callId: toolCallId, status });
  return [];
}

function translateSessionInfoUpdate(notification: unknown): InternalEvent[] {
  const parsed = sessionInfoUpdateSchema.safeParse(notification);
  if (!parsed.success) {
    log.warn("schema-validation-failed", {
      sessionUpdate: "session_info_update",
      issues: parsed.error.issues.length,
    });
    return [];
  }
  const { sessionId } = parsed.data;
  const { title } = parsed.data.update;
  if (typeof title !== "string") {
    log.debug("translate.session-info-update.no-title", { sessionId });
    return [];
  }
  // Source is always "auto": ACP rename comes from Hermes' titleStore, not
  // a user-issued rename. User-source renames flow through a separate
  // gateway command path.
  log.debug("translate.session-info-update", { sessionId, titleLen: title.length });
  return [{ type: "sessions.renamed", sessionId, title, source: "auto" }];
}

function translateAvailableCommandsUpdate(notification: unknown): InternalEvent[] {
  const parsed = availableCommandsUpdateSchema.safeParse(notification);
  if (!parsed.success) {
    log.warn("schema-validation-failed", {
      sessionUpdate: "available_commands_update",
      issues: parsed.error.issues.length,
    });
    return [];
  }
  const upstream = sanitizeUpstreamCommands(parsed.data.update.availableCommands);
  const commands = translateAvailableCommands(upstream);
  log.debug("translate.available-commands-update", {
    upstreamCount: upstream.length,
    outputCount: commands.length,
  });
  return [{ type: "commands.available", commands }];
}

const upstreamCommandSchema = z.object({ name: z.string(), description: z.string().optional() }).passthrough();

function sanitizeUpstreamCommands(raw: ReadonlyArray<unknown>): ReadonlyArray<{ name: string; description?: string }> {
  const out: Array<{ name: string; description?: string }> = [];
  for (const entry of raw) {
    const parsed = upstreamCommandSchema.safeParse(entry);
    if (!parsed.success) {
      log.warn("schema-validation-failed", { reason: "upstream-command-shape" });
      continue;
    }
    out.push(buildCommandEntry(parsed.data.name, parsed.data.description));
  }
  return out;
}

/**
 * T-A: map upstream's slash-command set to the gateway-vocab set. Output
 * order is deterministic — passthrough/renamed entries first (in upstream
 * order), then synthesized rows in the order declared above. Dropped
 * commands are filtered out.
 */
export function translateAvailableCommands(
  upstream: ReadonlyArray<{ name: string; description?: string }>,
): ReadonlyArray<{ name: string; description?: string }> {
  const out: Array<{ name: string; description?: string }> = [];
  for (const cmd of upstream) {
    if (DROPPED_COMMANDS.has(cmd.name)) continue;
    const renamed = COMMAND_RENAMES.get(cmd.name);
    if (renamed !== undefined) {
      out.push(buildCommandEntry(renamed, cmd.description));
      continue;
    }
    if (PASSTHROUGH_COMMANDS.has(cmd.name)) {
      out.push(buildCommandEntry(cmd.name, cmd.description));
      continue;
    }
    log.debug("translate.commands.dropped-unknown", { name: cmd.name });
  }
  for (const synth of SYNTHESIZED_COMMANDS) {
    out.push({ name: synth.name, description: synth.description });
  }
  return out;
}

function buildCommandEntry(name: string, description: string | undefined): { name: string; description?: string } {
  return description === undefined ? { name } : { name, description };
}

/** Stringify for inline display (argsPreview / summary). Strings pass through; objects JSON.stringify. Truncated to PREVIEW_MAX_CHARS. */
function previewValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? "";
    } catch (err: unknown) {
      log.warn("preview-stringify-failed", { reason: err instanceof Error ? err.message : "unknown" });
      return "";
    }
  }
  return raw.length > PREVIEW_MAX_CHARS ? raw.slice(0, PREVIEW_MAX_CHARS) : raw;
}

/** Upstream wraps progress text in `[{type:"content", content:{type:"text", text:"..."}}]`. Accept any first-slot text block. */
function extractProgressMessage(content: ReadonlyArray<unknown> | undefined): string | undefined {
  if (content === undefined || content.length === 0) return undefined;
  const first = content[0];
  if (typeof first !== "object" || first === null) return undefined;
  const inner = (first as { content?: unknown }).content ?? first;
  if (typeof inner !== "object" || inner === null) return undefined;
  const text = (inner as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}
