import { describe, expect, it } from "vitest";
import {
  conversationFeedAssistantItemSchema,
  conversationFeedItemSchema,
  conversationFeedToolItemSchema,
  conversationFeedTriggerItemSchema,
  conversationFeedUserItemSchema,
} from "./conversation.ts";
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
  streamResumedSchema,
  taskUpdateSchema,
  textInputSchema,
} from "./messages.ts";
import type { StreamResumed } from "./messages.ts";

describe("session.configure", () => {
  it("parses with explicit language", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      language: "zh",
      capabilities: { supports: ["audio", "text"] },
      clientType: "webui",
      deviceId: "dev-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.language).toBe("zh");
  });

  it("defaults language to en", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.language).toBe("en");
  });

  it("parses with deviceId carried through", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-xyz",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.deviceId).toBe("dev-xyz");
  });

  it("rejects missing deviceId", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty deviceId", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing capabilities", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      language: "en",
      clientType: "webui",
      deviceId: "dev-abc",
    });
    expect(result.success).toBe(false);
  });

  it("accepts clientType mobile", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: ["audio", "text"] },
      clientType: "mobile",
      deviceId: "dev-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.clientType).toBe("mobile");
  });

  it("rejects unknown clientType", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "tablet",
      deviceId: "dev-abc",
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
      deviceId: "dev-abc",
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
      entryId: "e-p1",
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
      entryId: "e-nopid",
      ts: 1000,
      kind: "user",
      channel: "text",
      content: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pendingId).toBeUndefined();
  });
});

describe("transport boundary — query RPCs removed from WS", () => {
  it("rejects sessions.list on the WS client schema", () => {
    expect(clientMessageSchema.safeParse({ type: "sessions.list", limit: 100, offset: 0 }).success).toBe(false);
  });
  it("rejects sessions.search/delete/rename on the WS client schema", () => {
    for (const type of ["sessions.search", "sessions.delete", "sessions.rename"]) {
      expect(clientMessageSchema.safeParse({ type, requestId: "x" }).success).toBe(false);
    }
  });
  it("accepts conversation.activate", () => {
    expect(clientMessageSchema.safeParse({ type: "conversation.activate", sessionId: "s-1" }).success).toBe(true);
  });
  it("drops sessions.*.result from the gateway schema but keeps broadcasts", () => {
    expect(
      gatewayMessageSchema.safeParse({
        type: "sessions.list.result",
        requestId: "r-1",
        items: [],
        total: 0,
        hasMore: false,
      }).success,
    ).toBe(false);
    expect(gatewayMessageSchema.safeParse({ type: "sessions.deleted", sessionId: "s-1" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 3.9 — seq/epoch on gateway push frames + resume handshake
// ---------------------------------------------------------------------------

describe("message.delta with seq/epoch (gateway push frames)", () => {
  it("parses message.delta WITHOUT seq/epoch (backwards compat)", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "message.delta",
      cycleId: "c-1",
      delta: "Hello",
    });
    expect(result.success).toBe(true);
  });

  it("parses message.delta WITH seq and epoch", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "message.delta",
      cycleId: "c-1",
      delta: "Hello",
      seq: 42,
      epoch: 7,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(42);
      expect(result.data.epoch).toBe(7);
    }
  });

  it("rejects negative seq", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "message.delta",
      cycleId: "c-1",
      delta: "Hello",
      seq: -1,
      epoch: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects fractional seq", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "message.delta",
      cycleId: "c-1",
      delta: "Hello",
      seq: 1.5,
      epoch: 0,
    });
    expect(result.success).toBe(false);
  });

  it("parses auth.ok WITH seq/epoch", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "auth.ok",
      sessionId: "s-1",
      role: "adult",
      seq: 0,
      epoch: 1,
    });
    expect(result.success).toBe(true);
  });

  it("parses cognition.status WITH seq/epoch", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "cognition.status",
      state: "thinking",
      runningEffects: [],
      seq: 100,
      epoch: 3,
    });
    expect(result.success).toBe(true);
  });
});

describe("stream.resume (client → gateway)", () => {
  it("accepts valid stream.resume", () => {
    const result = clientMessageSchema.safeParse({
      type: "stream.resume",
      epoch: 3,
      lastSeq: 99,
      deviceId: "dev-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("stream.resume");
    }
  });

  it("rejects stream.resume missing deviceId", () => {
    const result = clientMessageSchema.safeParse({
      type: "stream.resume",
      epoch: 3,
      lastSeq: 99,
    });
    expect(result.success).toBe(false);
  });

  it("rejects stream.resume with empty deviceId", () => {
    const result = clientMessageSchema.safeParse({
      type: "stream.resume",
      epoch: 3,
      lastSeq: 99,
      deviceId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects stream.resume with negative lastSeq", () => {
    const result = clientMessageSchema.safeParse({
      type: "stream.resume",
      epoch: 3,
      lastSeq: -1,
      deviceId: "dev-abc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects stream.resume with negative epoch", () => {
    const result = clientMessageSchema.safeParse({
      type: "stream.resume",
      epoch: -1,
      lastSeq: 99,
      deviceId: "dev-abc",
    });
    expect(result.success).toBe(false);
  });
});

describe("stream.resumed (gateway → client)", () => {
  it("accepts stream.resumed with recovered=true and optional seq range", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "stream.resumed",
      recovered: true,
      epoch: 3,
      fromSeq: 100,
      toSeq: 200,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("stream.resumed");
    }
  });

  it("accepts stream.resumed with recovered=false and no fromSeq/toSeq", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "stream.resumed",
      recovered: false,
      epoch: 3,
    });
    expect(result.success).toBe(true);
  });

  it("accepts stream.resumed with seq/epoch stamped (gateway push frame)", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "stream.resumed",
      recovered: true,
      epoch: 3,
      fromSeq: 100,
      toSeq: 200,
      seq: 201,
    });
    expect(result.success).toBe(true);
  });

  it("rejects stream.resumed missing recovered", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "stream.resumed",
      epoch: 3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects stream.resumed missing epoch", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "stream.resumed",
      recovered: true,
    });
    expect(result.success).toBe(false);
  });

  it("StreamResumed type includes seq — type and runtime agree", () => {
    // Type-level assertion: StreamResumed must have an optional seq field.
    // If the type lacks seq this line will produce a TS compile error.
    const typed: StreamResumed = {
      type: "stream.resumed",
      recovered: true,
      epoch: 5,
      seq: 201,
    };
    expect(typed.seq).toBe(201);

    // Runtime: streamResumedSchema (the exported wire schema) must parse seq.
    const result = streamResumedSchema.safeParse({
      type: "stream.resumed",
      recovered: true,
      epoch: 5,
      seq: 201,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(201);
      expect(result.data.epoch).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// conversationFeedItem entryId — Slice 3/4 dedupe key
// ---------------------------------------------------------------------------

describe("conversationFeedItem entryId — required on all kinds", () => {
  it("rejects a user item missing entryId", () => {
    const result = conversationFeedUserItemSchema.safeParse({
      ts: 1000,
      kind: "user",
      channel: "text",
      content: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a user item with entryId", () => {
    const result = conversationFeedUserItemSchema.safeParse({
      entryId: "abc-123",
      ts: 1000,
      kind: "user",
      channel: "text",
      content: "hello",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.entryId).toBe("abc-123");
  });

  it("rejects an assistant item missing entryId", () => {
    const result = conversationFeedAssistantItemSchema.safeParse({
      ts: 1000,
      kind: "assistant",
      content: "hi there",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an assistant item with entryId", () => {
    const result = conversationFeedAssistantItemSchema.safeParse({
      entryId: "def-456",
      ts: 1000,
      kind: "assistant",
      content: "hi there",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.entryId).toBe("def-456");
  });

  it("rejects a tool item missing entryId", () => {
    const result = conversationFeedToolItemSchema.safeParse({
      ts: 1000,
      kind: "tool",
      toolName: "search",
      status: "finished",
      summary: "done",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a tool item with entryId", () => {
    const result = conversationFeedToolItemSchema.safeParse({
      entryId: "ghi-789",
      ts: 1000,
      kind: "tool",
      toolName: "search",
      status: "finished",
      summary: "done",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.entryId).toBe("ghi-789");
  });

  it("rejects a trigger item missing entryId", () => {
    const result = conversationFeedTriggerItemSchema.safeParse({
      ts: 1000,
      kind: "trigger",
      source: "sensor.door",
      summary: "opened",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a trigger item with entryId", () => {
    const result = conversationFeedTriggerItemSchema.safeParse({
      entryId: "jkl-012",
      ts: 1000,
      kind: "trigger",
      source: "sensor.door",
      summary: "opened",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.entryId).toBe("jkl-012");
  });

  it("discriminated union rejects any kind missing entryId", () => {
    for (const item of [
      { ts: 0, kind: "user", channel: "text", content: "x" },
      { ts: 0, kind: "assistant", content: "y" },
      { ts: 0, kind: "tool", toolName: "t", status: "finished", summary: "s" },
      { ts: 0, kind: "trigger", source: "s", summary: "w" },
    ]) {
      expect(conversationFeedItemSchema.safeParse(item).success).toBe(false);
    }
  });
});
