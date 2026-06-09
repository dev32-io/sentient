import { describe, expect, it } from "vitest";
import { conversationFeedUserItemSchema } from "./conversation.ts";
import {
  clientMessageSchema,
  cognitionStatusSchema,
  connectorAudioDoneSchema,
  connectorAudioStartSchema,
  connectorCancelledSchema,
  connectorTranscriptFinalSchema,
  cycleAbortedSchema,
  cycleCompletedSchema,
  cycleStartedSchema,
  gatewayMessageSchema,
  messageDeltaSchema,
  messageDoneSchema,
  sessionConfigureSchema,
  sessionReadySchema,
  taskUpdateSchema,
  textInputSchema,
} from "./messages.ts";

describe("session.configure", () => {
  it("parses with explicit language", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      language: "zh",
      capabilities: { supports: ["audio", "text"] },
      clientType: "webui",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.language).toBe("zh");
  });

  it("defaults language to en", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.language).toBe("en");
  });

  it("rejects missing capabilities", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      language: "en",
    });
    expect(result.success).toBe(false);
  });

  it("accepts clientType mobile", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: ["audio", "text"] },
      clientType: "mobile",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.clientType).toBe("mobile");
  });

  it("rejects unknown clientType", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "tablet",
    });
    expect(result.success).toBe(false);
  });
});

describe("session.ready", () => {
  it("parses valid session.ready", () => {
    const result = sessionReadySchema.safeParse({
      type: "session.ready",
      sessionId: "s-123",
      audioEncoding: "pcm16",
      inputSampleRate: 16000,
      outputSampleRate: 48000,
      enabledEffects: ["tts", "stt"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing enabledEffects", () => {
    const result = sessionReadySchema.safeParse({
      type: "session.ready",
      sessionId: "s-123",
      audioEncoding: "pcm16",
      inputSampleRate: 16000,
      outputSampleRate: 48000,
    });
    expect(result.success).toBe(false);
  });

  it("parses session.ready with playback block", () => {
    const result = sessionReadySchema.safeParse({
      type: "session.ready",
      sessionId: "s-123",
      audioEncoding: "pcm16",
      inputSampleRate: 16000,
      outputSampleRate: 48000,
      enabledEffects: [],
      playback: { minEagerEndMs: 3000, preemptFadeoutMs: 30 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.playback?.minEagerEndMs).toBe(3000);
      expect(result.data.playback?.preemptFadeoutMs).toBe(30);
    }
  });

  it("session.ready without playback block is still valid (optional, backwards compat)", () => {
    const result = sessionReadySchema.safeParse({
      type: "session.ready",
      sessionId: "s-123",
      audioEncoding: "pcm16",
      inputSampleRate: 16000,
      outputSampleRate: 48000,
      enabledEffects: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.playback).toBeUndefined();
    }
  });
});

describe("cycle.started", () => {
  it("parses a valid cycle.started message", () => {
    const result = cycleStartedSchema.safeParse({
      type: "cycle.started",
      cycleId: "c-1",
      triggerKind: "voice",
      triggerSource: "UserAudioInputConnector",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing cycleId", () => {
    const result = cycleStartedSchema.safeParse({
      type: "cycle.started",
      triggerKind: "voice",
      triggerSource: "UserAudioInputConnector",
    });
    expect(result.success).toBe(false);
  });
});

describe("connector.cancelled", () => {
  it("parses valid connector.cancelled", () => {
    const result = connectorCancelledSchema.safeParse({
      type: "connector.cancelled",
      connector: "AssistantAudioResponseConnector",
      cycleId: "c-1",
      taskId: "t-1",
      reason: "barge_in",
    });
    expect(result.success).toBe(true);
  });
});

describe("cycle.aborted", () => {
  it("parses valid cycle.aborted", () => {
    const result = cycleAbortedSchema.safeParse({
      type: "cycle.aborted",
      cycleId: "c-1",
      reason: "client_disconnect",
    });
    expect(result.success).toBe(true);
  });
});

describe("cycle.completed", () => {
  it("parses with empty effectsInvoked", () => {
    const result = cycleCompletedSchema.safeParse({
      type: "cycle.completed",
      cycleId: "c-1",
      effectsInvoked: [],
    });
    expect(result.success).toBe(true);
  });

  it("parses with populated effectsInvoked", () => {
    const result = cycleCompletedSchema.safeParse({
      type: "cycle.completed",
      cycleId: "c-1",
      effectsInvoked: ["tts", "memory_write"],
    });
    expect(result.success).toBe(true);
  });
});

describe("connector.transcript.final", () => {
  it("parses valid transcript final", () => {
    const result = connectorTranscriptFinalSchema.safeParse({
      type: "connector.transcript.final",
      connector: "UserAudioInputConnector",
      text: "hello world",
      language: "en",
    });
    expect(result.success).toBe(true);
  });

  it("rejects wrong connector literal", () => {
    const result = connectorTranscriptFinalSchema.safeParse({
      type: "connector.transcript.final",
      connector: "WrongConnector",
      text: "hello",
      language: "en",
    });
    expect(result.success).toBe(false);
  });
});

describe("message.delta", () => {
  it("parses valid delta", () => {
    const result = messageDeltaSchema.safeParse({
      type: "message.delta",
      cycleId: "c-1",
      delta: "Hello",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing cycleId", () => {
    const result = messageDeltaSchema.safeParse({
      type: "message.delta",
      delta: "Hello",
    });
    expect(result.success).toBe(false);
  });
});

describe("message.done", () => {
  it("parses valid done", () => {
    const result = messageDoneSchema.safeParse({
      type: "message.done",
      cycleId: "c-1",
    });
    expect(result.success).toBe(true);
  });
});

describe("connector.audio.start", () => {
  it("parses valid audio start", () => {
    const result = connectorAudioStartSchema.safeParse({
      type: "connector.audio.start",
      connector: "AssistantAudioResponseConnector",
      cycleId: "c-1",
      taskId: "t-1",
      encoding: "pcm16",
      sampleRate: 48000,
    });
    expect(result.success).toBe(true);
  });
});

describe("connector.audio.done", () => {
  it("parses valid audio done", () => {
    const result = connectorAudioDoneSchema.safeParse({
      type: "connector.audio.done",
      connector: "AssistantAudioResponseConnector",
      cycleId: "c-1",
      taskId: "t-1",
    });
    expect(result.success).toBe(true);
  });
});

describe("cognition.status", () => {
  it("parses idle state", () => {
    const result = cognitionStatusSchema.safeParse({
      type: "cognition.status",
      state: "idle",
      runningEffects: [],
    });
    expect(result.success).toBe(true);
  });

  it("parses thinking state with effects", () => {
    const result = cognitionStatusSchema.safeParse({
      type: "cognition.status",
      state: "thinking",
      runningEffects: ["stt"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid state", () => {
    const result = cognitionStatusSchema.safeParse({
      type: "cognition.status",
      state: "sleeping",
      runningEffects: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("clientMessageSchema", () => {
  it("parses audio.start", () => {
    expect(clientMessageSchema.safeParse({ type: "audio.start" }).success).toBe(true);
  });

  it("parses session.configure with capabilities", () => {
    const result = clientMessageSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: ["audio"] },
      clientType: "webui",
    });
    expect(result.success).toBe(true);
  });

  it("rejects removed auth type", () => {
    expect(clientMessageSchema.safeParse({ type: "auth", token: "t" }).success).toBe(false);
  });

  it("rejects old turn-based types", () => {
    expect(clientMessageSchema.safeParse({ type: "barge_in" }).success).toBe(false);
  });
});

describe("gatewayMessageSchema", () => {
  it("parses cycle.started", () => {
    expect(
      gatewayMessageSchema.safeParse({
        type: "cycle.started",
        cycleId: "c-1",
        triggerKind: "text",
        triggerSource: "TextInputConnector",
      }).success,
    ).toBe(true);
  });

  it("parses message.delta", () => {
    expect(
      gatewayMessageSchema.safeParse({
        type: "message.delta",
        cycleId: "c-1",
        delta: "Hi",
      }).success,
    ).toBe(true);
  });

  it("rejects removed turn.started type", () => {
    expect(gatewayMessageSchema.safeParse({ type: "turn.started", turnIdx: 1 }).success).toBe(false);
  });

  it("rejects removed response.text.delta type", () => {
    expect(gatewayMessageSchema.safeParse({ type: "response.text.delta", text: "hi" }).success).toBe(false);
  });

  it("rejects removed transcript.partial type", () => {
    expect(gatewayMessageSchema.safeParse({ type: "transcript.partial", text: "hi" }).success).toBe(false);
  });
});

describe("task.update", () => {
  it("parses valid task.update with cycleId", () => {
    const result = taskUpdateSchema.safeParse({
      type: "task.update",
      taskId: "t1",
      toolName: "tool",
      cycleId: "cycle-1",
      status: "running",
      argsPreview: "",
      startedAtMs: 0,
    });
    expect(result.success).toBe(true);
  });

  it("requires cycleId on task.update", () => {
    const result = taskUpdateSchema.safeParse({
      type: "task.update",
      taskId: "t1",
      toolName: "tool",
      status: "running",
      argsPreview: "",
      startedAtMs: 0,
    });
    expect(result.success).toBe(false);
  });

  it("parses task.update with terminal status and endedAtMs", () => {
    const result = taskUpdateSchema.safeParse({
      type: "task.update",
      taskId: "t1",
      toolName: "tool",
      cycleId: "cycle-1",
      status: "finished",
      argsPreview: "",
      startedAtMs: 0,
      endedAtMs: 100,
    });
    expect(result.success).toBe(true);
  });
});

describe("text.input pendingId", () => {
  it("parses with pendingId present", () => {
    const result = textInputSchema.safeParse({
      type: "text.input",
      text: "hello",
      pendingId: "p1",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pendingId).toBe("p1");
  });

  it("parses without pendingId (backward compat — undefined)", () => {
    const result = textInputSchema.safeParse({
      type: "text.input",
      text: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pendingId).toBeUndefined();
  });
});

describe("conversationFeedUserItem pendingId", () => {
  it("parses with pendingId present", () => {
    const result = conversationFeedUserItemSchema.safeParse({
      ts: 1000,
      kind: "user",
      channel: "text",
      content: "hello",
      pendingId: "p1",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pendingId).toBe("p1");
  });

  it("parses without pendingId (backward compat — undefined)", () => {
    const result = conversationFeedUserItemSchema.safeParse({
      ts: 1000,
      kind: "user",
      channel: "text",
      content: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pendingId).toBeUndefined();
  });
});
