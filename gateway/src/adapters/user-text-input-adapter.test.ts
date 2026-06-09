import { describe, expect, it, vi } from "vitest";
import { createConversationMirror } from "../cerebrum/conversation-mirror.js";
import type { ConversationMirror } from "../cerebrum/conversation-mirror.js";
import type { ShortTermContext } from "../cerebrum/short-term-context-types.js";
import type { AdapterContext } from "./adapter-types.js";
import { createUserTextInputAdapter } from "./user-text-input-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(): {
  ctx: AdapterContext;
  inject: ReturnType<typeof vi.fn>;
  conversationMirror: ConversationMirror;
} {
  const inject = vi.fn().mockReturnValue(1);
  const shortTermContext = {
    sessionId: "test-session",
    inject: inject as ShortTermContext["inject"],
    project: vi.fn() as ShortTermContext["project"],
    latestSeq: vi.fn().mockReturnValue(0) as ShortTermContext["latestSeq"],
    onInject: vi.fn().mockReturnValue(() => {}) as ShortTermContext["onInject"],
  } satisfies ShortTermContext;
  const conversationMirror = createConversationMirror(100);
  const ctx: AdapterContext = {
    shortTermContext,
    conversationHistory: conversationMirror,
    abortSignal: new AbortController().signal,
  };
  return { ctx, inject, conversationMirror };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserTextInputAdapter", () => {
  it("does NOT inject into ShortTermContext on handleTextInput", async () => {
    const adapter = createUserTextInputAdapter();
    const { ctx, inject } = makeCtx();
    await adapter.start(ctx);

    adapter.handleTextInput("hello world");

    expect(inject).not.toHaveBeenCalled();
  });

  it("appends a user/text entry to conversation history on handleTextInput", async () => {
    const adapter = createUserTextInputAdapter();
    const { ctx, conversationMirror } = makeCtx();
    await adapter.start(ctx);

    adapter.handleTextInput("hello world");

    const entries = conversationMirror.snapshot();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.kind).toBe("user");
    expect((entry as { channel: string }).channel).toBe("text");
    expect((entry as { content: string }).content).toBe("hello world");
  });

  it("does nothing when adapter is stopped", async () => {
    const adapter = createUserTextInputAdapter();
    const { ctx, conversationMirror } = makeCtx();
    await adapter.start(ctx);
    await adapter.stop("test");

    adapter.handleTextInput("ignored");

    expect(conversationMirror.snapshot()).toHaveLength(0);
  });

  it("adapter start/stop lifecycle sets and clears context", async () => {
    const adapter = createUserTextInputAdapter();
    const { ctx, conversationMirror } = makeCtx();

    await adapter.start(ctx);
    adapter.handleTextInput("first");
    expect(conversationMirror.snapshot()).toHaveLength(1);

    await adapter.stop("done");
    adapter.handleTextInput("second");
    expect(conversationMirror.snapshot()).toHaveLength(1); // still only one
  });

  it("exposes empty eventKinds", () => {
    const adapter = createUserTextInputAdapter();
    expect(adapter.eventKinds).toEqual([]);
  });

  it("threads pendingId onto the appended user entry when provided", async () => {
    const adapter = createUserTextInputAdapter();
    const { ctx, conversationMirror } = makeCtx();
    await adapter.start(ctx);

    adapter.handleTextInput("hello", "p1");

    const entries = conversationMirror.snapshot();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.kind).toBe("user");
    expect((entry as { pendingId?: string }).pendingId).toBe("p1");
  });

  it("leaves pendingId undefined when not provided (backward compat)", async () => {
    const adapter = createUserTextInputAdapter();
    const { ctx, conversationMirror } = makeCtx();
    await adapter.start(ctx);

    adapter.handleTextInput("hi");

    const entries = conversationMirror.snapshot();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.kind).toBe("user");
    expect((entry as { pendingId?: string }).pendingId).toBeUndefined();
  });
});
