import { describe, expect, it } from "vitest";
import {
  agentMessageChunkSchema,
  agentThoughtChunkSchema,
  initializeParamsSchema,
  initializeResultSchema,
  sessionCancelParamsSchema,
  sessionListSessionInfoSchema,
  sessionLoadParamsSchema,
  sessionNewParamsSchema,
  sessionPromptResultSchema,
  sessionUpdateParamsSchema,
  toolCallSchema,
  toolCallUpdateSchema,
} from "./schemas.js";

// Defensive tests for the wire-shape corrections vs. upstream `acp/schema.py`
// (v0.11.2). These pin contract divergences caught against real Hermes
// frames; loosening any of these silently re-introduces the original bugs.

describe("initializeParamsSchema — protocolVersion required", () => {
  it("accepts protocolVersion: 1 with clientCapabilities", () => {
    const result = initializeParamsSchema.safeParse({
      protocolVersion: 1,
      clientCapabilities: { sessionList: true },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing protocolVersion (plan sample omitted it)", () => {
    const result = initializeParamsSchema.safeParse({
      clientCapabilities: { sessionList: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects protocolVersion: 2 (unsupported)", () => {
    const result = initializeParamsSchema.safeParse({
      protocolVersion: 2,
      clientCapabilities: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("initializeResultSchema — protocolVersion bounded to upstream ge=0/le=65535", () => {
  it("accepts protocolVersion at the upper bound 65535", () => {
    const result = initializeResultSchema.safeParse({ protocolVersion: 65535 });
    expect(result.success).toBe(true);
  });

  it("rejects protocolVersion above 65535", () => {
    const result = initializeResultSchema.safeParse({ protocolVersion: 65536 });
    expect(result.success).toBe(false);
  });

  it("rejects negative protocolVersion", () => {
    const result = initializeResultSchema.safeParse({ protocolVersion: -1 });
    expect(result.success).toBe(false);
  });
});

describe("sessionNewParamsSchema — cwd + mcpServers required upstream", () => {
  it("accepts cwd plus empty mcpServers array", () => {
    const result = sessionNewParamsSchema.safeParse({ cwd: "/", mcpServers: [] });
    expect(result.success).toBe(true);
  });

  it("rejects missing cwd", () => {
    const result = sessionNewParamsSchema.safeParse({ mcpServers: [] });
    expect(result.success).toBe(false);
  });

  it("rejects missing mcpServers", () => {
    const result = sessionNewParamsSchema.safeParse({ cwd: "/" });
    expect(result.success).toBe(false);
  });
});

describe("sessionLoadParamsSchema — cwd + mcpServers required upstream", () => {
  it("accepts sessionId + cwd + empty mcpServers", () => {
    const result = sessionLoadParamsSchema.safeParse({
      sessionId: "sess_1",
      cwd: "/",
      mcpServers: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing cwd", () => {
    const result = sessionLoadParamsSchema.safeParse({
      sessionId: "sess_1",
      mcpServers: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing mcpServers", () => {
    const result = sessionLoadParamsSchema.safeParse({
      sessionId: "sess_1",
      cwd: "/",
    });
    expect(result.success).toBe(false);
  });
});

describe("sessionCancelParamsSchema — notification body", () => {
  it("accepts {sessionId} for session/cancel", () => {
    const result = sessionCancelParamsSchema.safeParse({ sessionId: "sess_1" });
    expect(result.success).toBe(true);
  });
});

describe("sessionListSessionInfoSchema — cwd REQUIRED", () => {
  it("accepts a minimal upstream row", () => {
    const result = sessionListSessionInfoSchema.safeParse({
      sessionId: "sess_1",
      title: "Hello",
      cwd: "/",
      updatedAt: "2026-05-07T23:39:36.416924+00:00",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a row with title:null", () => {
    const result = sessionListSessionInfoSchema.safeParse({
      sessionId: "sess_2",
      title: null,
      cwd: "/",
      updatedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a row missing cwd (upstream SessionInfo requires it)", () => {
    const result = sessionListSessionInfoSchema.safeParse({
      sessionId: "sess_3",
      title: "Hello",
      updatedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("sessionPromptResultSchema — stopReason pinned to upstream literals", () => {
  it("accepts every upstream StopReason literal", () => {
    const literals = ["end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"];
    for (const stopReason of literals) {
      const result = sessionPromptResultSchema.safeParse({ stopReason });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown stopReason (no string fallback)", () => {
    const result = sessionPromptResultSchema.safeParse({ stopReason: "ratelimited" });
    expect(result.success).toBe(false);
  });
});

describe("agent_message_chunk / agent_thought_chunk — content is a discriminated block", () => {
  it("accepts content as a text block (the real wire shape)", () => {
    const result = agentMessageChunkSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts content as an image block", () => {
    const result = agentMessageChunkSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "image",
          data: "base64-bytes",
          mimeType: "image/png",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects bare-string content (the previous wrong shape)", () => {
    const result = agentMessageChunkSchema.safeParse({
      sessionId: "sess_1",
      update: { sessionUpdate: "agent_message_chunk", content: "hello" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects array content (the other previous wrong shape)", () => {
    const result = agentMessageChunkSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: [{ type: "text", text: "hello" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown content block type literal", () => {
    const result = agentMessageChunkSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "totally_made_up", text: "x" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("agent_thought_chunk uses the same content shape (probe-found variant)", () => {
    const result = agentThoughtChunkSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "ruminating..." },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("toolCall vs toolCallUpdate — title required only on the initial frame", () => {
  it("accepts a tool_call with title", () => {
    const result = toolCallSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_42",
        title: "Searching home assistant",
        status: "pending",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tool_call without title (upstream ToolCall.title is required)", () => {
    const result = toolCallSchema.safeParse({
      sessionId: "sess_1",
      update: { sessionUpdate: "tool_call", toolCallId: "call_42", status: "pending" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a tool_call_update without title (matches upstream ToolCallUpdate)", () => {
    const result = toolCallUpdateSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_42",
        status: "completed",
        rawOutput: { ok: true },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("sessionUpdateParamsSchema — discriminator on update.sessionUpdate", () => {
  it("routes through the union for tool_call_update", () => {
    const result = sessionUpdateParamsSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_42",
        status: "completed",
        rawOutput: { ok: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown sessionUpdate literal in the union", () => {
    const result = sessionUpdateParamsSchema.safeParse({
      sessionId: "sess_1",
      update: {
        sessionUpdate: "totally_made_up",
        content: { type: "text", text: "x" },
      },
    });
    expect(result.success).toBe(false);
  });
});
