import { describe, expect, it } from "vitest";
import { createConversationMirror } from "./conversation-mirror.js";
import type { HermesClient, HermesProfileBinding } from "./hermes-client.js";
import type { HermesDispatchRequest, HermesDispatcherDeps } from "./hermes-dispatcher.js";
import { dispatchHermesCycle } from "./hermes-dispatcher.js";
import type { DispatchMode, HermesEvent } from "./hermes-event-types.js";
import { createTaskMirror } from "./task-mirror.js";

// ---------------------------------------------------------------------------
// Fake HermesClient
// ---------------------------------------------------------------------------

function fakeClient(events: HermesEvent[]): HermesClient {
  return {
    async *dispatch(_input: unknown, _signal: AbortSignal, _mode: DispatchMode): AsyncGenerator<HermesEvent> {
      for (const ev of events) {
        yield ev;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBinding(overrides?: Partial<HermesProfileBinding>): HermesProfileBinding {
  return {
    userId: "u1",
    url: "https://hermes.test",
    apiKey: "key-test",
    conversationId: null,
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<HermesDispatchRequest>): HermesDispatchRequest {
  return {
    sessionId: "s1",
    userId: "u1",
    cycleId: "c1",
    userMessage: "hello",
    binding: makeBinding(),
    maxOutputTokens: 256,
    signal: new AbortController().signal,
    mode: { bargedIn: () => false },
    ...overrides,
  };
}

function makeDeps(client: HermesClient): HermesDispatcherDeps {
  return {
    clientFor: () => client,
    mirror: createConversationMirror(),
    tasks: createTaskMirror(),
    emit: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchHermesCycle", () => {
  it("captures conversationId from created event and returns it", async () => {
    const events: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv-42" },
      { type: "text.delta", delta: "Hi" },
      { type: "completed", usage: { inputTokens: 5, outputTokens: 2 } },
    ];

    const client = fakeClient(events);
    const deps = makeDeps(client);
    const req = makeRequest();

    const result = await dispatchHermesCycle(req, deps);

    expect(result.conversationId).toBe("conv-42");
  });

  it("returns null conversationId when stream has no created event", async () => {
    const events: HermesEvent[] = [
      { type: "text.delta", delta: "Hi" },
      { type: "completed", usage: { inputTokens: 5, outputTokens: 2 } },
    ];

    const client = fakeClient(events);
    const deps = makeDeps(client);
    const req = makeRequest();

    const result = await dispatchHermesCycle(req, deps);

    expect(result.conversationId).toBeNull();
  });

  it("passes binding conversationId as initial value before created event", async () => {
    const events: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv-new" },
      { type: "completed", usage: { inputTokens: 0, outputTokens: 0 } },
    ];

    const client = fakeClient(events);
    const deps = makeDeps(client);
    const req = makeRequest({
      binding: makeBinding({ conversationId: "conv-existing" }),
    });

    const result = await dispatchHermesCycle(req, deps);

    // The created event overrides the initial value
    expect(result.conversationId).toBe("conv-new");
  });

  it("emits wire messages and updates mirror via translator", async () => {
    const events: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv-1" },
      { type: "text.delta", delta: "Hello " },
      { type: "text.delta", delta: "world" },
      { type: "completed", usage: { inputTokens: 10, outputTokens: 5 } },
    ];

    const client = fakeClient(events);
    const emitted: Record<string, unknown>[] = [];
    const deps: HermesDispatcherDeps = {
      clientFor: () => client,
      mirror: createConversationMirror(),
      tasks: createTaskMirror(),
      emit: (msg) => {
        emitted.push(msg);
      },
    };

    await dispatchHermesCycle(makeRequest(), deps);

    // Translator should have emitted cycle lifecycle messages
    expect(emitted.some((m) => m.type === "cycle.started")).toBe(true);
    expect(emitted.some((m) => m.type === "cycle.completed")).toBe(true);

    // Mirror should have an assistant entry
    expect(deps.mirror.size()).toBe(1);
    const snapshot = deps.mirror.snapshot();
    const entry = snapshot[0];
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("assistant");
    if (entry?.kind === "assistant") {
      expect(entry.content).toBe("Hello world");
    }
  });

  it("delegates to clientFor with the provided binding", async () => {
    const events: HermesEvent[] = [{ type: "completed", usage: { inputTokens: 0, outputTokens: 0 } }];

    let receivedBinding: HermesProfileBinding | null = null;
    const client = fakeClient(events);
    const deps: HermesDispatcherDeps = {
      clientFor: (binding) => {
        receivedBinding = binding;
        return client;
      },
      mirror: createConversationMirror(),
      tasks: createTaskMirror(),
      emit: () => {},
    };

    const binding = makeBinding({ userId: "special-user", url: "https://custom.test" });
    await dispatchHermesCycle(makeRequest({ binding }), deps);

    expect(receivedBinding).toBe(binding);
  });

  it("calls startTts with text deltas and awaits its completion", async () => {
    const events: HermesEvent[] = [
      { type: "created", responseId: "r1", conversationId: "conv-1" },
      { type: "text.delta", delta: "Hello" },
      { type: "text.delta", delta: " world" },
      { type: "completed", usage: { inputTokens: 5, outputTokens: 2 } },
    ];

    const client = fakeClient(events);
    const receivedDeltas: string[] = [];
    let receivedCycleId = "";

    const deps: HermesDispatcherDeps = {
      clientFor: () => client,
      mirror: createConversationMirror(),
      tasks: createTaskMirror(),
      emit: () => {},
      startTts: (deltas, cycleId) => {
        receivedCycleId = cycleId;
        return {
          done: (async () => {
            for await (const d of deltas) {
              if (typeof d === "string") receivedDeltas.push(d);
            }
          })(),
          cancel: () => {},
        };
      },
    };

    await dispatchHermesCycle(makeRequest(), deps);

    expect(receivedDeltas).toEqual(["Hello", " world"]);
    expect(receivedCycleId).toBe("c1");
  });

  it("works without startTts (drains textDeltas internally)", async () => {
    const events: HermesEvent[] = [
      { type: "text.delta", delta: "some text" },
      { type: "completed", usage: { inputTokens: 1, outputTokens: 1 } },
    ];

    const client = fakeClient(events);
    const deps = makeDeps(client);

    const result = await dispatchHermesCycle(makeRequest(), deps);
    expect(result.conversationId).toBeNull();
  });
});
