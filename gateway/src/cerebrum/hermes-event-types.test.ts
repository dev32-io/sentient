import { describe, expect, it } from "vitest";
import { hermesEventSchema } from "./hermes-event-types.js";

describe("hermesEventSchema", () => {
  it("parses a created event", () => {
    const result = hermesEventSchema.safeParse({
      type: "created",
      responseId: "resp-1",
      conversationId: "conv-1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "created",
        responseId: "resp-1",
        conversationId: "conv-1",
      });
    }
  });

  it("parses a text.delta event with empty string", () => {
    const result = hermesEventSchema.safeParse({
      type: "text.delta",
      delta: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ type: "text.delta", delta: "" });
    }
  });

  it("parses a text.delta event with content", () => {
    const result = hermesEventSchema.safeParse({
      type: "text.delta",
      delta: "Hello",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ type: "text.delta", delta: "Hello" });
    }
  });

  it("parses a tool.started event", () => {
    const result = hermesEventSchema.safeParse({
      type: "tool.started",
      callId: "call-1",
      toolName: "speak",
      argsPreview: "Hello world",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "tool.started",
        callId: "call-1",
        toolName: "speak",
        argsPreview: "Hello world",
      });
    }
  });

  it("parses a tool.args.delta event (conditional)", () => {
    const result = hermesEventSchema.safeParse({
      type: "tool.args.delta",
      callId: "call-1",
      delta: '{"te',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "tool.args.delta",
        callId: "call-1",
        delta: '{"te',
      });
    }
  });

  it("parses a tool.finished event with ok status", () => {
    const result = hermesEventSchema.safeParse({
      type: "tool.finished",
      callId: "call-1",
      status: "ok",
      summary: "Spoke greeting",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "tool.finished",
        callId: "call-1",
        status: "ok",
        summary: "Spoke greeting",
      });
    }
  });

  it("parses a tool.finished event with failed status", () => {
    const result = hermesEventSchema.safeParse({
      type: "tool.finished",
      callId: "call-2",
      status: "failed",
      summary: "Service unavailable",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "tool.finished",
        callId: "call-2",
        status: "failed",
        summary: "Service unavailable",
      });
    }
  });

  it("rejects a tool.finished event with invalid status", () => {
    const result = hermesEventSchema.safeParse({
      type: "tool.finished",
      callId: "call-1",
      status: "pending",
      summary: "Not done yet",
    });
    expect(result.success).toBe(false);
  });

  it("parses a completed event", () => {
    const result = hermesEventSchema.safeParse({
      type: "completed",
      usage: { inputTokens: 42, outputTokens: 128 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "completed",
        usage: { inputTokens: 42, outputTokens: 128 },
      });
    }
  });

  it("rejects a completed event with negative tokens", () => {
    const result = hermesEventSchema.safeParse({
      type: "completed",
      usage: { inputTokens: -1, outputTokens: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("parses an error event", () => {
    const result = hermesEventSchema.safeParse({
      type: "error",
      message: "Connection refused",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        type: "error",
        message: "Connection refused",
      });
    }
  });

  it("rejects unknown event type", () => {
    const result = hermesEventSchema.safeParse({
      type: "unknown.event",
      data: "something",
    });
    expect(result.success).toBe(false);
  });

  it("rejects object without type field", () => {
    const result = hermesEventSchema.safeParse({
      responseId: "resp-1",
      conversationId: "conv-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects created event missing required fields", () => {
    const result = hermesEventSchema.safeParse({
      type: "created",
      responseId: "resp-1",
      // conversationId missing
    });
    expect(result.success).toBe(false);
  });
});
