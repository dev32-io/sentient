import { describe, expect, it } from "vitest";
import {
  conversationFeedAssistantItemSchema,
  conversationFeedItemSchema,
  conversationFeedToolItemSchema,
  conversationFeedTriggerItemSchema,
  conversationFeedUserItemSchema,
} from "./conversation.ts";
import {
  audioStartSchema,
  clientMessageSchema,
  conversationEntrySchema,
  delegationProgressSchema,
  gatewayMessageSchema,
  permissionRequestSchema,
  permissionResolvedSchema,
  permissionResponseSchema,
  playbackStopSchema,
  sessionConfigureSchema,
  sessionReadySchema,
  streamResumedSchema,
  textInputSchema,
  turnAbortedSchema,
  turnAudioStartSchema,
  turnStartedSchema,
  turnTextDeltaSchema,
  turnToolUpdateSchema,
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

  it("parses configure-carried resume on a reconnect", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-abc",
      resume: { epoch: 3, lastSeq: 99 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.resume).toEqual({ epoch: 3, lastSeq: 99 });
  });

  it("omits resume on a fresh connect (undefined)", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.resume).toBeUndefined();
  });

  it("rejects resume with a negative lastSeq", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-abc",
      resume: { epoch: 3, lastSeq: -1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects resume with a negative epoch", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-abc",
      resume: { epoch: -1, lastSeq: 99 },
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

describe("audio.start turnMode (hold/toggle-talk split design §4)", () => {
  it("defaults turnMode to semantic when absent", () => {
    const result = audioStartSchema.safeParse({ type: "audio.start" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.turnMode).toBe("semantic");
  });

  it("parses explicit turnMode=manual", () => {
    const result = audioStartSchema.safeParse({ type: "audio.start", turnMode: "manual" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.turnMode).toBe("manual");
  });

  it("parses explicit turnMode=semantic", () => {
    const result = audioStartSchema.safeParse({ type: "audio.start", turnMode: "semantic" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.turnMode).toBe("semantic");
  });

  it("rejects an invalid turnMode value", () => {
    expect(audioStartSchema.safeParse({ type: "audio.start", turnMode: "auto" }).success).toBe(false);
  });
});

describe("clientMessageSchema", () => {
  it("parses audio.start", () => {
    expect(clientMessageSchema.safeParse({ type: "audio.start" }).success).toBe(true);
  });

  it("parses audio.start with turnMode=manual (client⇒gateway wire contract)", () => {
    const result = clientMessageSchema.safeParse({ type: "audio.start", turnMode: "manual" });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "audio.start") {
      expect(result.data.turnMode).toBe("manual");
    }
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

  // CONTRACT: the exact payload-nested shape all three clients send for the
  // in-chat mute toggle (web-sdk PreferencesConnector, mobile-sdk
  // ClientMessage.UserPreferencesPatch, gateway/webui's TTS toggle). The 2.0
  // purge deleted the handler and left the frame out of this union, so every
  // tap was answered with protocol_error — which neither SDK renders.
  it("parses user.preferences.patch with a payload-nested audio patch", () => {
    const result = clientMessageSchema.safeParse({
      type: "user.preferences.patch",
      payload: { ttsEnabled: false },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "user.preferences.patch") {
      expect(result.data.payload.ttsEnabled).toBe(false);
      expect(result.data.payload.channel).toBeUndefined();
    }
  });

  it("rejects a user.preferences.patch whose fields are not nested under payload", () => {
    expect(clientMessageSchema.safeParse({ type: "user.preferences.patch", ttsEnabled: false }).success).toBe(false);
  });

  it("rejects removed auth type", () => {
    expect(clientMessageSchema.safeParse({ type: "auth", token: "t" }).success).toBe(false);
  });

  it("rejects old turn-based types", () => {
    expect(clientMessageSchema.safeParse({ type: "barge_in" }).success).toBe(false);
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

describe("seq/epoch stamping on gateway push frames", () => {
  const delta = { type: "turn.text.delta", turnId: "t-1", text: "Hello" };

  it("parses a push frame WITHOUT seq/epoch (pre-sequencing frame)", () => {
    expect(gatewayMessageSchema.safeParse(delta).success).toBe(true);
  });

  it("parses a push frame WITH seq and epoch", () => {
    const result = gatewayMessageSchema.safeParse({ ...delta, seq: 42, epoch: 7 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seq).toBe(42);
      expect(result.data.epoch).toBe(7);
    }
  });

  it("rejects negative seq", () => {
    expect(gatewayMessageSchema.safeParse({ ...delta, seq: -1, epoch: 0 }).success).toBe(false);
  });

  it("rejects fractional seq", () => {
    expect(gatewayMessageSchema.safeParse({ ...delta, seq: 1.5, epoch: 0 }).success).toBe(false);
  });

  it("parses auth.ok WITH seq/epoch", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "auth.ok",
      user: { userId: "u_a1b2c3d4", displayName: "Kevin", isAdmin: false, avatarTint: "terra" },
      seq: 0,
      epoch: 1,
    });
    expect(result.success).toBe(true);
  });

  it("parses turn.tool.update WITH seq/epoch", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "turn.tool.update",
      turnId: "t-1",
      toolCallId: "c-1",
      toolName: "search",
      status: "running",
      argsPreview: "",
      startedAtMs: 1,
      seq: 100,
      epoch: 3,
    });
    expect(result.success).toBe(true);
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

// ---------------------------------------------------------------------------
// session.configure conversationId — resume-conversation-continuity
// ---------------------------------------------------------------------------

describe("session.configure conversationId", () => {
  it("accepts session.configure with an optional conversationId", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "mobile",
      deviceId: "dev-1",
      conversationId: "conv-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.conversationId).toBe("conv-abc");
  });

  it("accepts session.configure with conversationId omitted (back-compat)", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-1",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.conversationId).toBeUndefined();
  });

  it("rejects empty-string conversationId", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-1",
      conversationId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("session.configure surfaceId", () => {
  it("accepts session.configure with an optional surfaceId", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-1",
      surfaceId: "surf-tab-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.surfaceId).toBe("surf-tab-abc");
  });

  it("accepts session.configure with surfaceId omitted (old-client back-compat)", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-1",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.surfaceId).toBeUndefined();
  });

  it("rejects empty-string surfaceId", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-1",
      surfaceId: "",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wire contract v2 (spec §7) — the frozen 2.0 gateway → client frame set.
// These tests exist because four packages (gateway, web-sdk, webui, KMP SDK)
// decode these bytes at a process boundary; a silent rename here is a
// production-only failure. Pin the SHAPES, not the plumbing.
// ---------------------------------------------------------------------------

describe("turn lifecycle frames", () => {
  it("parses turn.started with a user trigger", () => {
    const result = turnStartedSchema.safeParse({ type: "turn.started", turnId: "t-1", trigger: "user" });
    expect(result.success).toBe(true);
  });

  it("parses turn.started with a background-completion trigger", () => {
    const result = turnStartedSchema.safeParse({
      type: "turn.started",
      turnId: "t-1",
      trigger: "background-completion",
    });
    expect(result.success).toBe(true);
  });

  it("rejects turn.started without a trigger", () => {
    expect(turnStartedSchema.safeParse({ type: "turn.started", turnId: "t-1" }).success).toBe(false);
  });

  it("rejects an unknown turn.started trigger", () => {
    expect(turnStartedSchema.safeParse({ type: "turn.started", turnId: "t-1", trigger: "ambient" }).success).toBe(
      false,
    );
  });

  it("turn.text.delta carries turnId — the field response.text.delta was missing", () => {
    expect(turnTextDeltaSchema.safeParse({ type: "turn.text.delta", turnId: "t-1", text: "hi" }).success).toBe(true);
    expect(turnTextDeltaSchema.safeParse({ type: "turn.text.delta", text: "hi" }).success).toBe(false);
  });

  it("parses turn.aborted for both cutoff kinds", () => {
    for (const cutoff of ["interrupt", "barge-in"]) {
      expect(turnAbortedSchema.safeParse({ type: "turn.aborted", turnId: "t-1", cutoff }).success).toBe(true);
    }
  });

  it("rejects an unknown turn.aborted cutoff", () => {
    expect(turnAbortedSchema.safeParse({ type: "turn.aborted", turnId: "t-1", cutoff: "timeout" }).success).toBe(false);
  });
});

describe("turn.tool.update", () => {
  const base = {
    type: "turn.tool.update",
    turnId: "t-1",
    toolCallId: "c-1",
    toolName: "delegateTask",
    status: "running",
    argsPreview: '{"agent":"hermes"}',
    startedAtMs: 1000,
  };

  it("parses a foreground running update (no taskId, no endedAtMs)", () => {
    expect(turnToolUpdateSchema.safeParse(base).success).toBe(true);
  });

  it("parses a background running update carrying taskId", () => {
    expect(turnToolUpdateSchema.safeParse({ ...base, taskId: "task-9" }).success).toBe(true);
  });

  it("parses a terminal update carrying endedAtMs", () => {
    expect(turnToolUpdateSchema.safeParse({ ...base, status: "done", endedAtMs: 1200 }).success).toBe(true);
  });

  it("requires argsPreview and startedAtMs", () => {
    for (const field of ["argsPreview", "startedAtMs"]) {
      const incomplete: Record<string, unknown> = { ...base };
      delete incomplete[field];
      expect(turnToolUpdateSchema.safeParse(incomplete).success, `missing ${field}`).toBe(false);
    }
  });

  it("rejects the retired task.update status vocabulary", () => {
    for (const status of ["finished", "cancelled", "failed"]) {
      expect(turnToolUpdateSchema.safeParse({ ...base, status }).success).toBe(false);
    }
  });
});

describe("turn.audio.start encoding", () => {
  it("accepts opus and pcm", () => {
    for (const encoding of ["opus", "pcm"]) {
      expect(
        turnAudioStartSchema.safeParse({ type: "turn.audio.start", turnId: "t-1", encoding, sampleRate: 48000 })
          .success,
      ).toBe(true);
    }
  });

  it("rejects pcm16 — the wire enum is exactly opus | pcm", () => {
    expect(
      turnAudioStartSchema.safeParse({ type: "turn.audio.start", turnId: "t-1", encoding: "pcm16", sampleRate: 48000 })
        .success,
    ).toBe(false);
  });

  it("rejects a non-positive sampleRate", () => {
    expect(
      turnAudioStartSchema.safeParse({ type: "turn.audio.start", turnId: "t-1", encoding: "opus", sampleRate: 0 })
        .success,
    ).toBe(false);
  });
});

describe("permission mediation frames (spec §7.1)", () => {
  it("parses permission.request with args and an expiry", () => {
    const result = permissionRequestSchema.safeParse({
      type: "permission.request",
      requestId: "r-1",
      toolCallId: "c-1",
      toolName: "sendMessage",
      args: { to: "+1555", body: "hi" },
      description: "Send a message to +1555",
      expiresAtMs: 1_700_000_000_000,
    });
    expect(result.success).toBe(true);
  });

  it("parses permission.resolved for every outcome — timeout included (fail-closed)", () => {
    for (const outcome of ["allowed", "denied", "timeout"]) {
      expect(
        permissionResolvedSchema.safeParse({ type: "permission.resolved", requestId: "r-1", outcome }).success,
      ).toBe(true);
    }
  });

  it("rejects an unknown permission outcome", () => {
    expect(
      permissionResolvedSchema.safeParse({ type: "permission.resolved", requestId: "r-1", outcome: "expired" }).success,
    ).toBe(false);
  });

  it("clientMessageSchema accepts permission.response and rejects the retired tool.confirm", () => {
    expect(
      clientMessageSchema.safeParse({ type: "permission.response", requestId: "r-1", approved: true }).success,
    ).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "tool.confirm", toolCallId: "c-1", approved: true }).success).toBe(
      false,
    );
  });

  it("permission.response requires an explicit boolean — a missing decision is never an approval", () => {
    expect(permissionResponseSchema.safeParse({ type: "permission.response", requestId: "r-1" }).success).toBe(false);
  });
});

describe("delegation.progress (spec §5.4)", () => {
  it("parses a running update without a note", () => {
    const result = delegationProgressSchema.safeParse({
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "running",
    });
    expect(result.success).toBe(true);
  });

  it("parses a terminal update with a note", () => {
    const result = delegationProgressSchema.safeParse({
      type: "delegation.progress",
      taskId: "task-1",
      turnId: "t-1",
      agent: "hermes",
      status: "error",
      note: "provider timeout",
    });
    expect(result.success).toBe(true);
  });
});

describe("turnId rekey (cycleId is gone from the 2.0 wire)", () => {
  it("playback.stop is keyed by turnId", () => {
    expect(playbackStopSchema.safeParse({ type: "playback.stop", turnId: "t-1", reason: "barge-in" }).success).toBe(
      true,
    );
    expect(playbackStopSchema.safeParse({ type: "playback.stop", cycleId: "c-1", reason: "barge-in" }).success).toBe(
      false,
    );
  });

  it("conversation.entry carries an optional turnId on the FRAME, never on the item", () => {
    const item = { entryId: "e-1", ts: 1, kind: "assistant" as const, content: "hi" };
    const withTurn = conversationEntrySchema.safeParse({ type: "conversation.entry", turnId: "t-1", item });
    expect(withTurn.success).toBe(true);
    expect(withTurn.success && withTurn.data.turnId).toBe("t-1");

    // Absent on a user-echo / out-of-band entry.
    const without = conversationEntrySchema.safeParse({ type: "conversation.entry", item });
    expect(without.success).toBe(true);
    expect(without.success && without.data.turnId).toBeUndefined();
  });
});

describe("gatewayMessageSchema — the 2.0 union", () => {
  it("admits every new 2.0 frame", () => {
    const frames = [
      { type: "turn.started", turnId: "t-1", trigger: "user" },
      { type: "turn.text.delta", turnId: "t-1", text: "hi" },
      { type: "turn.completed", turnId: "t-1" },
      { type: "turn.aborted", turnId: "t-1", cutoff: "interrupt" },
      {
        type: "turn.tool.update",
        turnId: "t-1",
        toolCallId: "c-1",
        toolName: "search",
        status: "done",
        argsPreview: "{}",
        startedAtMs: 1,
        endedAtMs: 2,
      },
      { type: "turn.audio.start", turnId: "t-1", encoding: "opus", sampleRate: 48000 },
      { type: "turn.audio.done", turnId: "t-1" },
      {
        type: "permission.request",
        requestId: "r-1",
        toolCallId: "c-1",
        toolName: "sendMessage",
        args: {},
        description: "d",
        expiresAtMs: 1,
      },
      { type: "permission.resolved", requestId: "r-1", outcome: "denied" },
      { type: "delegation.progress", taskId: "task-1", turnId: "t-1", agent: "hermes", status: "running" },
      { type: "playback.stop", turnId: "t-1", reason: "interrupt" },
    ];
    for (const frame of frames) {
      expect(gatewayMessageSchema.safeParse(frame).success, `frame ${frame.type}`).toBe(true);
    }
  });

  it("rejects every retired pre-2.0 frame type", () => {
    const retired = [
      "cycle.started",
      "cycle.aborted",
      "cycle.completed",
      "message.delta",
      "message.done",
      "connector.audio.start",
      "connector.audio.done",
      "connector.cancelled",
      "connector.transcript.final",
      "task.update",
      "tool.confirm_request",
      "cognition.status",
    ];
    for (const type of retired) {
      expect(gatewayMessageSchema.safeParse({ type }).success, `retired ${type}`).toBe(false);
    }
  });

  // Reconciliation note (deliberate, reviewed): this file used to assert that
  // the literal "turn.started" was REJECTED — it was a pre-cerebrum frame
  // retired long ago. The 2.0 contract legitimately reuses that type string
  // for the native turn (spec §7: "cycle.* may become turn.* — not preserved
  // out of timidity"). The rejection that still matters is the old PAYLOAD:
  // `{ turnIdx }` with no turnId/trigger must not squeak through.
  it("accepts the 2.0 turn.started payload but still rejects the retired turnIdx payload", () => {
    expect(gatewayMessageSchema.safeParse({ type: "turn.started", turnId: "t-1", trigger: "user" }).success).toBe(true);
    expect(gatewayMessageSchema.safeParse({ type: "turn.started", turnIdx: 1 }).success).toBe(false);
  });

  it("rejects response.text.delta — Plan 2's interim frame, never a contract frame", () => {
    expect(gatewayMessageSchema.safeParse({ type: "response.text.delta", text: "hi" }).success).toBe(false);
  });

  it("rejects transcript.partial — no partial-transcript frame exists in 2.0", () => {
    expect(gatewayMessageSchema.safeParse({ type: "transcript.partial", text: "hi" }).success).toBe(false);
  });
});
