import type { ConversationFeedItem } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
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
  return { ts, kind: "user", channel: "text", content };
}

function assistantItem(content: string, ts = 2): ConversationFeedItem {
  return { ts, kind: "assistant", content };
}

function toolItem(summary: string, ts = 3): ConversationFeedItem {
  return { ts, kind: "tool", toolName: "speak", status: "finished", summary };
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

  it("resets the mirror on detach", () => {
    const connector = new ConversationHistoryConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("conversation.entry")?.({ type: "conversation.entry", item: userItem("hi") });
    expect(connector.items()).toHaveLength(1);

    connector.detach();
    expect(connector.items()).toEqual([]);
  });

  it("subsequent attach resets the mirror for the new session", () => {
    const connector = new ConversationHistoryConnector();
    const internal1 = createMockInternal();
    connector.attach(internal1);
    internal1.messageHandlers.get("conversation.entry")?.({ type: "conversation.entry", item: userItem("hi") });
    connector.detach();

    const internal2 = createMockInternal();
    connector.attach(internal2);
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
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 1, channel: "text", content: "old" }] });
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 2, channel: "text", content: "new" }] });
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("new");
  });

  it("conversation.entry between session.switched and next snapshot is dropped", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 1, channel: "text", content: "a" }] });
    expect(c.items()).toHaveLength(1);
    sdk.emit("session.switched", { sessionId: "s2", ts: 2 });
    sdk.emit("conversation.entry", { item: { kind: "user", ts: 3, channel: "text", content: "stale" } });
    // Mirror still shows old session's snapshot — the stale entry was dropped during the gap.
    expect(c.items().some((i) => (i as { content?: string }).content === "stale")).toBe(false);
  });

  it("snapshot after session.switched releases the gate; subsequent entries apply", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 1, channel: "text", content: "a" }] });
    sdk.emit("session.switched", { sessionId: "s2", ts: 2 });
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 4, channel: "text", content: "fresh" }] });
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("fresh");
    sdk.emit("conversation.entry", { item: { kind: "user", ts: 5, channel: "text", content: "live" } });
    expect(c.items()).toHaveLength(2);
  });

  it("entry without prior switched still applies (normal append path)", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", { items: [] });
    sdk.emit("conversation.entry", { item: { kind: "user", ts: 1, channel: "text", content: "live" } });
    expect(c.items()).toHaveLength(1);
  });
});
