import type { ConversationFeedItem } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import type { SessionsRest } from "../sessions-rest.ts";
import { ConversationHistoryConnector } from "./conversation-history-connector.ts";

function createMockInternal(): SentientSDKInternal & {
  messageHandlers: Map<string, (msg: unknown) => void>;
} {
  const messageHandlers = new Map<string, (msg: unknown) => void>();
  return {
    messageHandlers,
    send() {},
    sendBinary() {},
    onMessage(type: string, handler: (msg: unknown) => void) {
      messageHandlers.set(type, handler);
      return () => {
        messageHandlers.delete(type);
      };
    },
    onBinary(_handler: (data: ArrayBuffer) => void) {
      return () => {};
    },
  };
}

function userItem(content: string, ts = 1): ConversationFeedItem {
  return { entryId: `user:${ts}:${content}`, ts, kind: "user", channel: "text", content };
}

function assistantItem(content: string, ts = 2): ConversationFeedItem {
  return { entryId: `assistant:${ts}:${content}`, ts, kind: "assistant", content };
}

function toolItem(summary: string, ts = 3): ConversationFeedItem {
  return { entryId: `tool:${ts}:${summary}`, ts, kind: "tool", toolName: "speak", status: "finished", summary };
}

describe("ConversationHistoryConnector", () => {
  it("has capability conversation.history and kind status", () => {
    const connector = new ConversationHistoryConnector();
    expect(connector.capability).toBe("conversation.history");
    expect(connector.kind).toBe("status");
  });

  it("starts with an empty mirror", () => {
    const connector = new ConversationHistoryConnector();
    expect(connector.items()).toEqual([]);
  });

  it("hydrates the mirror from conversation.snapshot", () => {
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    const connector = new ConversationHistoryConnector({ onSnapshot, onUpdate });
    const internal = createMockInternal();
    connector.attach(internal);

    const items = [userItem("hi"), assistantItem("hello")];
    internal.messageHandlers.get("conversation.snapshot")?.({ type: "conversation.snapshot", items });

    expect(connector.items()).toHaveLength(2);
    expect(connector.items()[0]?.kind).toBe("user");
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("appends on conversation.entry", () => {
    const onEntry = vi.fn();
    const onUpdate = vi.fn();
    const connector = new ConversationHistoryConnector({ onEntry, onUpdate });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.snapshot")?.({ type: "conversation.snapshot", items: [] });
    internal.messageHandlers.get("conversation.entry")?.({ type: "conversation.entry", item: userItem("hi") });
    internal.messageHandlers.get("conversation.entry")?.({ type: "conversation.entry", item: assistantItem("hello") });
    internal.messageHandlers.get("conversation.entry")?.({ type: "conversation.entry", item: toolItem("said hi") });

    expect(connector.items()).toHaveLength(3);
    expect(connector.items().map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(onEntry).toHaveBeenCalledTimes(3);
    // 1 for snapshot + 3 for entries
    expect(onUpdate).toHaveBeenCalledTimes(4);
  });

  it("re-attaches the frame turnId to a committed assistant entry (no client-side id invention)", () => {
    const onEntry = vi.fn();
    const connector = new ConversationHistoryConnector({ onEntry });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.entry")?.({
      type: "conversation.entry",
      turnId: "t-1",
      item: assistantItem("hello"),
    });

    expect(connector.items()[0]?.turnId).toBe("t-1");
    expect(onEntry).toHaveBeenCalledWith(expect.objectContaining({ turnId: "t-1", kind: "assistant" }));
  });

  it("leaves turnId undefined for an entry with no originating turn (user echo)", () => {
    const connector = new ConversationHistoryConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.entry")?.({
      type: "conversation.entry",
      item: userItem("hi"),
    });

    expect(connector.items()[0]?.turnId).toBeUndefined();
  });

  it("ignores malformed entry messages", () => {
    const onEntry = vi.fn();
    const connector = new ConversationHistoryConnector({ onEntry });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.entry")?.({ type: "conversation.entry" });
    expect(connector.items()).toEqual([]);
    expect(onEntry).not.toHaveBeenCalled();
  });

  it("handles missing items field in snapshot gracefully", () => {
    const connector = new ConversationHistoryConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.snapshot")?.({ type: "conversation.snapshot" });
    expect(connector.items()).toEqual([]);
  });

  it("keeps the mirror across detach — detach is transport teardown, not session teardown", () => {
    const connector = new ConversationHistoryConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.entry")?.({ type: "conversation.entry", item: userItem("hi") });
    expect(connector.items()).toHaveLength(1);

    connector.detach();
    expect(connector.items()).toHaveLength(1);
  });

  it("stops delivering entries after detach", () => {
    const onEntry = vi.fn();
    const connector = new ConversationHistoryConnector({ onEntry });
    const internal = createMockInternal();
    connector.attach(internal);
    connector.detach();

    expect(internal.messageHandlers.size).toBe(0);
    expect(onEntry).not.toHaveBeenCalled();
  });

  // The reconnect FSM: teardownWsForReconnect detaches every connector, the
  // reconnect re-attaches them on session.ready, and a `recovered:true` resume
  // replays ONLY the frames the client missed — deliberately no
  // conversation.snapshot (ws-session-configure.ts). If attach cleared the
  // mirror, the next replayed entry would be the ONLY item the UI ever sees
  // and the whole chat would collapse to a single bubble.
  it("preserves the mirror across a reconnect detach/attach cycle and appends the replayed entries", () => {
    const onUpdate = vi.fn();
    const connector = new ConversationHistoryConnector({ onUpdate });
    const internal1 = createMockInternal();
    connector.attach(internal1);
    internal1.messageHandlers.get("conversation.snapshot")?.({
      type: "conversation.snapshot",
      items: [userItem("hi"), assistantItem("hello")],
    });
    expect(connector.items()).toHaveLength(2);

    // Reconnect: teardown detaches, session.ready re-attaches.
    connector.detach();
    const internal2 = createMockInternal();
    connector.attach(internal2);

    // recovered:true replay — the missed entry only, no snapshot.
    internal2.messageHandlers.get("conversation.entry")?.({
      type: "conversation.entry",
      item: userItem("and again", 3),
    });

    expect(connector.items().map((i) => i.kind)).toEqual(["user", "assistant", "user"]);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ kind: "assistant" })]));
  });

  it("reset() clears the mirror on a genuine session/identity teardown", () => {
    const connector = new ConversationHistoryConnector();
    const internal = createMockInternal();
    connector.attach(internal);
    internal.messageHandlers.get("conversation.entry")?.({ type: "conversation.entry", item: userItem("hi") });
    expect(connector.items()).toHaveLength(1);

    connector.reset();
    expect(connector.items()).toEqual([]);
  });
});

const fakeSdk = () => {
  const handlers: Record<string, ((m: unknown) => void)[]> = {};
  return {
    onMessage(type: string, fn: (m: unknown) => void) {
      const list = handlers[type] ?? [];
      list.push(fn);
      handlers[type] = list;
      return () => {};
    },
    emit(type: string, msg: unknown) {
      for (const h of handlers[type] ?? []) h(msg);
    },
  };
};

describe("ConversationHistoryConnector — snapshot replace semantics", () => {
  it("subsequent snapshot replaces, does not merge", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", {
      items: [{ entryId: "e", kind: "user", ts: 1, channel: "text", content: "old" }],
    });
    sdk.emit("conversation.snapshot", {
      items: [{ entryId: "e", kind: "user", ts: 2, channel: "text", content: "new" }],
    });
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("new");
  });

  it("conversation.entry between session.switched and REST load is dropped", async () => {
    const sdk = fakeSdk();
    let resolveMessages!: (items: ConversationFeedItem[]) => void;
    const pendingFetch = new Promise<ConversationFeedItem[]>((res) => {
      resolveMessages = res;
    });
    const rest: SessionsRest = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
      search: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockReturnValue(pendingFetch),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const c = new ConversationHistoryConnector({}, rest);
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", {
      items: [{ entryId: "e", kind: "user", ts: 1, channel: "text", content: "a" }],
    });
    expect(c.items()).toHaveLength(1);
    sdk.emit("session.switched", { sessionId: "s2", ts: 2 });
    // Entry arrives while REST fetch is in flight — must be dropped.
    sdk.emit("conversation.entry", { item: { entryId: "e", kind: "user", ts: 3, channel: "text", content: "stale" } });
    expect(c.items().some((i) => (i as { content?: string }).content === "stale")).toBe(false);
    // Resolve fetch and verify mirror is replaced.
    resolveMessages([{ entryId: "e", kind: "user", ts: 4, channel: "text", content: "fresh" }]);
    await pendingFetch;
    await Promise.resolve(); // flush microtask
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("fresh");
  });

  it("REST load after session.switched releases the gate; subsequent entries apply", async () => {
    const sdk = fakeSdk();
    const freshItems: ConversationFeedItem[] = [
      { entryId: "e", kind: "user", ts: 4, channel: "text", content: "fresh" },
    ];
    const rest: SessionsRest = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
      search: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue(freshItems),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const c = new ConversationHistoryConnector({}, rest);
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", {
      items: [{ entryId: "e", kind: "user", ts: 1, channel: "text", content: "a" }],
    });
    sdk.emit("session.switched", { sessionId: "s2", ts: 2 });
    // Wait for the microtask queue to drain (REST mock resolves immediately).
    await Promise.resolve();
    await Promise.resolve();
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("fresh");
    sdk.emit("conversation.entry", { item: { entryId: "e", kind: "user", ts: 5, channel: "text", content: "live" } });
    expect(c.items()).toHaveLength(2);
  });

  it("entry without prior switched still applies (normal append path)", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", { items: [] });
    sdk.emit("conversation.entry", { item: { entryId: "e", kind: "user", ts: 1, channel: "text", content: "live" } });
    expect(c.items()).toHaveLength(1);
  });
});

describe("ConversationHistoryConnector — REST history on switch", () => {
  function makeRest(items: ConversationFeedItem[]): SessionsRest {
    return {
      list: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
      search: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue(items),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("fetches messages via REST and replaces mirror on session.switched", async () => {
    const sdk = fakeSdk();
    const historyItems: ConversationFeedItem[] = [
      { entryId: "e", kind: "user", ts: 10, channel: "text", content: "old msg" },
      { entryId: "e", kind: "assistant", ts: 11, content: "old reply" },
    ];
    const rest = makeRest(historyItems);
    const onSnapshot = vi.fn();
    const onUpdate = vi.fn();
    const c = new ConversationHistoryConnector({ onSnapshot, onUpdate }, rest);
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);

    sdk.emit("conversation.snapshot", {
      items: [{ entryId: "e", kind: "user", ts: 1, channel: "text", content: "initial" }],
    });
    expect(c.items()).toHaveLength(1);

    sdk.emit("session.switched", { sessionId: "s2" });
    expect(rest.getMessages).toHaveBeenCalledWith("s2");

    await Promise.resolve();
    await Promise.resolve();

    expect(c.items()).toHaveLength(2);
    expect(c.items()[0]?.kind).toBe("user");
    expect(c.items()[1]?.kind).toBe("assistant");
    // onSnapshot fires after REST load (same semantics as WS snapshot)
    expect(onSnapshot).toHaveBeenCalledTimes(2); // once for initial, once after switch
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("stale-switch guard: second switch cancels first fetch", async () => {
    const sdk = fakeSdk();
    let resolveFirst!: (items: ConversationFeedItem[]) => void;
    const firstFetch = new Promise<ConversationFeedItem[]>((res) => {
      resolveFirst = res;
    });
    const secondItems: ConversationFeedItem[] = [{ entryId: "e", kind: "assistant", ts: 20, content: "second" }];
    const rest: SessionsRest = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
      search: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockReturnValueOnce(firstFetch).mockResolvedValueOnce(secondItems),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const c = new ConversationHistoryConnector({}, rest);
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);

    sdk.emit("session.switched", { sessionId: "s1" });
    sdk.emit("session.switched", { sessionId: "s2" });

    // Wait for second fetch (resolves immediately) to land.
    await Promise.resolve();
    await Promise.resolve();
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("second");

    // Now resolve the first (stale) fetch — must NOT overwrite.
    resolveFirst([{ entryId: "e", kind: "user", ts: 5, channel: "text", content: "stale" }]);
    await firstFetch;
    await Promise.resolve();
    // Mirror still shows the second session's data.
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("second");
  });

  it("REST error clears awaitingSnapshot so the UI is not wedged", async () => {
    const sdk = fakeSdk();
    const oldItem: ConversationFeedItem = { entryId: "e", kind: "user", ts: 1, channel: "text", content: "old" };
    const rest: SessionsRest = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0, hasMore: false }),
      search: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockRejectedValue(new Error("network error")),
      rename: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const onUpdate = vi.fn();
    const c = new ConversationHistoryConnector({ onUpdate }, rest);
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);

    // Populate the mirror with the prior session's data.
    sdk.emit("conversation.snapshot", { items: [oldItem] });
    expect(c.items()).toHaveLength(1);

    sdk.emit("session.switched", { sessionId: "s1" });
    // Let the rejected promise settle
    await new Promise((res) => setTimeout(res, 0));

    // Mirror must be EMPTY (not stale) after a failed switch fetch — matches mobile behaviour.
    expect(c.items()).toHaveLength(0);
    // Gate cleared despite error — new entries must flow through.
    sdk.emit("conversation.entry", { item: { entryId: "e", kind: "user", ts: 2, channel: "text", content: "live" } });
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("live");
  });

  it("no-REST fallback: gate is cleared immediately and entries flow", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector(); // no REST
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);

    sdk.emit("session.switched", { sessionId: "s1" });
    // With no REST, gate clears immediately.
    sdk.emit("conversation.entry", { item: { entryId: "e", kind: "user", ts: 1, channel: "text", content: "live" } });
    expect(c.items()).toHaveLength(1);
  });
});
