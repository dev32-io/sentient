import { describe, expect, it, vi } from "vitest";
import { createConversationMirror } from "../cerebrum/conversation-mirror.js";
import type { ConversationMirror } from "../cerebrum/conversation-mirror.js";
import type { ShortTermContext } from "../cerebrum/short-term-context-types.js";
import type { AdapterContext } from "./adapter-types.js";
import type { STTAdapter, STTAdapterConfig, STTAdapterFactory, STTEvent } from "./stt/stt-adapter-types.js";
import { createUserAudioInputAdapter } from "./user-audio-input-adapter.js";

// ---------------------------------------------------------------------------
// Fake STT adapter with manual event emission
// ---------------------------------------------------------------------------

interface FakeSTTAdapter extends STTAdapter {
  _emit(event: STTEvent): void;
  _close(): void;
}

function makeFakeSttAdapter(): FakeSTTAdapter {
  const listeners: Array<(event: STTEvent | null) => void> = [];
  let closed = false;

  return {
    open: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    close: vi.fn().mockImplementation(async () => {
      closed = true;
      for (const l of listeners) l(null);
      listeners.length = 0;
    }),
    suppressInputFor: vi.fn(),

    async *events(signal: AbortSignal): AsyncGenerator<STTEvent> {
      while (true) {
        const next = await new Promise<STTEvent | null>((resolve) => {
          if (closed || signal.aborted) {
            resolve(null);
            return;
          }
          listeners.push(resolve);
          signal.addEventListener(
            "abort",
            () => {
              const idx = listeners.indexOf(resolve);
              if (idx !== -1) listeners.splice(idx, 1);
              resolve(null);
            },
            { once: true },
          );
        });
        if (next === null) return;
        yield next;
      }
    },

    _emit(event: STTEvent): void {
      const resolve = listeners.shift();
      resolve?.(event);
    },

    _close(): void {
      closed = true;
      for (const l of listeners) l(null);
      listeners.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush enough microtask turns for async generators to process one event. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const BASE_STT_CONFIG: STTAdapterConfig = {
  url: "ws://fake-stt:8766",
  language: "en",
  pauseRenderLanguage: "en",
  inputSampleRate: 48000,
  ttsEchoCooldownMs: 0,
  connectTimeoutMs: 1000,
  audioFormat: "pcm16",
};

function makeCtxWithInject(): {
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
  const abortController = new AbortController();
  const conversationMirror = createConversationMirror(100);
  const ctx: AdapterContext = {
    shortTermContext,
    conversationHistory: conversationMirror,
    abortSignal: abortController.signal,
    admitPendingId: () => true,
  };
  return { ctx, inject, conversationMirror };
}

function makeSttFactory(fakeAdapter: FakeSTTAdapter): STTAdapterFactory {
  return (_config: STTAdapterConfig) => fakeAdapter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserAudioInputAdapter", () => {
  it("does NOT inject into ShortTermContext on turn_started", async () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    const { ctx, inject } = makeCtxWithInject();

    await adapter.start(ctx);

    fake._emit({ type: "turn_started", turnIdx: 1 });
    await flushMicrotasks();

    expect(inject).not.toHaveBeenCalled();

    await adapter.stop("done");
  });

  it("does NOT inject into ShortTermContext on transcript event", async () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    const { ctx, inject } = makeCtxWithInject();

    await adapter.start(ctx);

    fake._emit({ type: "transcript", turnIdx: 1, text: "hello world" });
    await flushMicrotasks();

    expect(inject).not.toHaveBeenCalled();

    await adapter.stop("done");
  });

  it("does NOT inject into ShortTermContext on turn_dropped", async () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    const { ctx, inject } = makeCtxWithInject();

    await adapter.start(ctx);

    fake._emit({ type: "turn_dropped", turnIdx: 1 });
    await flushMicrotasks();

    expect(inject).not.toHaveBeenCalled();

    await adapter.stop("done");
  });

  it("appends user/speech entry to conversationMirror on transcript", async () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    const { ctx, conversationMirror } = makeCtxWithInject();

    await adapter.start(ctx);

    fake._emit({ type: "transcript", turnIdx: 1, text: "hello world" });
    await flushMicrotasks();

    const entries = conversationMirror.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("user");
    expect((entries[0] as { channel: string }).channel).toBe("speech");
    expect((entries[0] as { content: string }).content).toBe("hello world");

    await adapter.stop("done");
  });

  it("does NOT append to conversationMirror on turn_started or turn_dropped", async () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    const { ctx, conversationMirror } = makeCtxWithInject();

    await adapter.start(ctx);

    fake._emit({ type: "turn_started", turnIdx: 1 });
    await flushMicrotasks();
    fake._emit({ type: "turn_dropped", turnIdx: 1 });
    await flushMicrotasks();

    expect(conversationMirror.snapshot()).toHaveLength(0);

    await adapter.stop("done");
  });

  it("fires onSpeechOnset hook on turn_started before transcript arrives", async () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    const { ctx } = makeCtxWithInject();
    const onsetHook = vi.fn();

    await adapter.start(ctx);
    adapter.setOnSpeechOnset(onsetHook);

    fake._emit({ type: "turn_started", turnIdx: 1 });
    await flushMicrotasks();

    expect(onsetHook).toHaveBeenCalledOnce();

    await adapter.stop("done");
  });

  it("forwards binary audio frames to STT adapter verbatim (codec-agnostic)", async () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    const { ctx } = makeCtxWithInject();

    await adapter.start(ctx);

    // Adapter is codec-agnostic: bytes pass through unchanged whether they
    // are int16_le PCM samples or opus packets. STT decodes based on its
    // own audioFormat URL query param (set at connect time).
    const bytes = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    adapter.sendAudioFrame(bytes);

    expect(fake.send).toHaveBeenCalledOnce();
    const [sentArg] = (fake.send as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(sentArg).toBe(bytes);

    await adapter.stop("done");
  });

  it("closes STT adapter on stop", async () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    const { ctx } = makeCtxWithInject();

    await adapter.start(ctx);
    await adapter.stop("shutdown");

    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("exposes empty eventKinds", () => {
    const fake = makeFakeSttAdapter();
    const adapter = createUserAudioInputAdapter(makeSttFactory(fake), BASE_STT_CONFIG);
    expect(adapter.eventKinds).toEqual([]);
  });

  it("resolves start() cleanly even when initial open() fails (supervisor retries in background)", async () => {
    // The supervisor keeps retrying; we use a factory that returns a
    // dead adapter whose open() always throws. start() should still resolve.
    const deadAdapter: STTAdapter = {
      open: vi.fn().mockRejectedValue(new Error("stt-service down")),
      send: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      suppressInputFor: vi.fn(),
      async *events(): AsyncGenerator<STTEvent> {
        /* never yields */
      },
    };
    const factory: STTAdapterFactory = () => deadAdapter;
    const adapter = createUserAudioInputAdapter(factory, BASE_STT_CONFIG);
    const { ctx } = makeCtxWithInject();

    // start() must NOT throw even when STT is down — session stays alive and
    // the supervisor handles reconnects.
    await expect(adapter.start(ctx)).resolves.toBeUndefined();

    await adapter.stop("done");
  });
});
