import { describe, expect, it } from "vitest";
import { translateAvailableCommands, translateSessionUpdate } from "./event-translator.js";

// Defensive tests for the ACP→internal event translator. These pin the wire
// contract between Hermes' `session/update` notifications and the internal
// event union consumed by cerebrum/SDK. The translator is the only place
// that knows ACP shapes; loosening any of these tests silently re-introduces
// shape drift.

describe("translateSessionUpdate — agent_message_chunk", () => {
  it("maps text content to a single assistant.message event", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
      },
    });
    expect(events).toEqual([{ type: "assistant.message", text: "Hello" }]);
  });

  it("drops image content (gateway does not render images today)", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "AAAA", mimeType: "image/png" },
      },
    });
    expect(events).toEqual([]);
  });
});

describe("translateSessionUpdate — agent_thought_chunk", () => {
  it("silently drops narrator-style status text", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "( •_•)>⌐■-■ ruminating..." },
      },
    });
    expect(events).toEqual([]);
  });
});

describe("translateSessionUpdate — tool_call (initial frame)", () => {
  it("emits tool.started with toolName from title and JSON args preview", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-42",
        title: "search_web",
        rawInput: { query: "weather in tokyo" },
      },
    });
    expect(events).toEqual([
      {
        type: "tool.started",
        callId: "call-42",
        toolName: "search_web",
        argsPreview: '{"query":"weather in tokyo"}',
      },
    ]);
  });

  it("truncates argsPreview to 120 chars", () => {
    const longQuery = "x".repeat(500);
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-43",
        title: "search_web",
        rawInput: { query: longQuery },
      },
    });
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type !== "tool.started") throw new Error("expected tool.started");
    expect(event.argsPreview.length).toBeLessThanOrEqual(120);
  });
});

describe("translateSessionUpdate — tool_call_update", () => {
  it("emits tool.progress when status=in_progress with content message", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-42",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "fetching" } }],
      },
    });
    expect(events).toEqual([{ type: "tool.progress", callId: "call-42", message: "fetching" }]);
  });

  it("emits tool.finished status=ok when status=completed with rawOutput", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-42",
        status: "completed",
        rawOutput: { temperature: 72, condition: "sunny" },
      },
    });
    expect(events).toEqual([
      {
        type: "tool.finished",
        callId: "call-42",
        status: "ok",
        summary: '{"temperature":72,"condition":"sunny"}',
      },
    ]);
  });

  it("emits tool.finished status=failed when status=failed with string rawOutput", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-42",
        status: "failed",
        rawOutput: "rate limited",
      },
    });
    expect(events).toEqual([
      {
        type: "tool.finished",
        callId: "call-42",
        status: "failed",
        summary: "rate limited",
      },
    ]);
  });

  it("returns no events when status=pending (no-op)", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-42",
        status: "pending",
      },
    });
    expect(events).toEqual([]);
  });
});

describe("translateSessionUpdate — session_info_update", () => {
  it("emits sessions.renamed with source=auto when title is non-null", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "Cat story",
      },
    });
    expect(events).toEqual([
      {
        type: "sessions.renamed",
        sessionId: "sess-1",
        title: "Cat story",
        source: "auto",
      },
    ]);
  });

  it("emits no event when title is null (cleared)", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "session_info_update",
        title: null,
      },
    });
    expect(events).toEqual([]);
  });
});

describe("translateSessionUpdate — available_commands_update", () => {
  it("translates upstream's 7 commands to gateway's 5 in deterministic order", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help", description: "Show help" },
          { name: "model", description: "Switch model" },
          { name: "tools", description: "List tools" },
          { name: "context", description: "Show context" },
          { name: "reset", description: "Reset conversation" },
          { name: "compact", description: "Compact history" },
          { name: "version", description: "Show version" },
        ],
      },
    });
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type !== "commands.available") throw new Error("expected commands.available");
    expect(event.commands).toEqual([
      { name: "model", description: "Switch model" },
      { name: "clear", description: "Reset conversation" },
      { name: "personality", description: "Edit your assistant's persona (SOUL.md)" },
      { name: "new", description: "Start a new chat" },
      { name: "skills", description: "Browse available skills" },
    ]);
  });
});

describe("translateSessionUpdate — forward-compat", () => {
  it("returns no events for unknown sessionUpdate discriminator", () => {
    const events = translateSessionUpdate({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "plan",
        plan: "some-future-feature",
      },
    });
    expect(events).toEqual([]);
  });

  it("returns no events when input fails schema validation", () => {
    const events = translateSessionUpdate({
      sessionId: 42, // wrong type
      update: { sessionUpdate: "agent_message_chunk" },
    });
    expect(events).toEqual([]);
  });
});

describe("translateAvailableCommands — T-A command map", () => {
  it("includes synthesized commands even when upstream is empty", () => {
    const out = translateAvailableCommands([]);
    expect(out).toEqual([
      { name: "personality", description: "Edit your assistant's persona (SOUL.md)" },
      { name: "new", description: "Start a new chat" },
      { name: "skills", description: "Browse available skills" },
    ]);
  });

  it("renames reset to clear and drops dropped commands", () => {
    const out = translateAvailableCommands([
      { name: "help", description: "Show help" },
      { name: "tools", description: "List tools" },
      { name: "reset", description: "Reset chat" },
    ]);
    expect(out).toEqual([
      { name: "clear", description: "Reset chat" },
      { name: "personality", description: "Edit your assistant's persona (SOUL.md)" },
      { name: "new", description: "Start a new chat" },
      { name: "skills", description: "Browse available skills" },
    ]);
  });

  it("passes model through unchanged with its description", () => {
    const out = translateAvailableCommands([{ name: "model", description: "Switch the active model" }]);
    expect(out[0]).toEqual({ name: "model", description: "Switch the active model" });
  });
});
