import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { Capability } from "../access/capability.js";
import type { NewSessionEntry } from "./entry-types.js";
import { openSessionStore } from "./session-store.js";

const ROOT = "/tmp/sentient-store-test";
mkdirSync(`${ROOT}/u_aaaaaaaa`, { recursive: true });

const cap: Capability = Object.freeze({
  ownerUserId: "u_aaaaaaaa",
  resource: "session-store",
  rootPath: `${ROOT}/u_aaaaaaaa`,
});

function entry(overrides: Partial<NewSessionEntry> = {}): NewSessionEntry {
  return {
    sessionId: "s1",
    turnId: "t1",
    kind: "user",
    createdAt: Date.now(),
    text: "hi",
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    ...overrides,
  };
}

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("SessionStore", () => {
  it("assigns monotonic seq and a timestamp on append", () => {
    const store = openSessionStore(cap);
    const a = store.append(entry({ sessionId: "seqtest", text: "one" }));
    const b = store.append(entry({ sessionId: "seqtest", text: "two" }));
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(a.createdAt).toBeGreaterThan(0);
    store.close();
  });

  it("INVARIANT: exposes no mutating API — history is append-only", () => {
    const store = openSessionStore(cap);
    const opaque = store as unknown as Record<string, unknown>;
    expect(opaque.update).toBeUndefined();
    expect(opaque.delete).toBeUndefined();
    expect(opaque.replace).toBeUndefined();
    store.close();
  });

  it("reads a session back in append order, surviving reopen", () => {
    const store = openSessionStore(cap);
    store.append(entry({ sessionId: "persist", text: "first" }));
    store.append(entry({ sessionId: "persist", kind: "assistant", text: "second" }));
    store.close();

    const reopened = openSessionStore(cap);
    const rows = reopened.readSession("persist");
    expect(rows.map((r) => r.text)).toEqual(["first", "second"]);
    expect(rows[0]?.kind).toBe("user");
    expect(rows[1]?.kind).toBe("assistant");
    reopened.close();
  });

  it("readSince returns only entries after the given seq", () => {
    const store = openSessionStore(cap);
    const first = store.append(entry({ sessionId: "since", text: "a" }));
    store.append(entry({ sessionId: "since", text: "b" }));
    const later = store.readSince("since", first.seq);
    expect(later.map((r) => r.text)).toEqual(["b"]);
    store.close();
  });

  it("round-trips tool_call and tool_result correlation fields", () => {
    const store = openSessionStore(cap);
    store.append(
      entry({
        sessionId: "tools",
        kind: "tool_call",
        text: null,
        toolCallId: "call_1",
        toolName: "search",
        toolArgs: '{"q":"weather"}',
      }),
    );
    store.append(
      entry({
        sessionId: "tools",
        kind: "tool_result",
        text: null,
        toolCallId: "call_1",
        toolName: "search",
        toolArgs: '{"temp":"20C"}',
      }),
    );
    const rows = store.readSession("tools");
    expect(rows[0]?.toolCallId).toBe("call_1");
    expect(rows[1]?.toolCallId).toBe("call_1");
    expect(rows[1]?.kind).toBe("tool_result");
    store.close();
  });

  it("creates its owner's home dir when absent, then opens", () => {
    // A freshly-created user whose home dir was never provisioned. The store
    // must mkdir its own scoped root — not fail with "unable to open database
    // file". Regression for the live-WS e2e where session.configure threw.
    const freshRoot = `${ROOT}/u_bbbbbbbb`; // NOT pre-created above
    const freshCap: Capability = Object.freeze({
      ownerUserId: "u_bbbbbbbb",
      resource: "session-store",
      rootPath: freshRoot,
    });
    const store = openSessionStore(freshCap);
    const appended = store.append(entry({ sessionId: "fresh", text: "hi" }));
    expect(appended.seq).toBeGreaterThan(0);
    expect(existsSync(freshRoot)).toBe(true);
    store.close();
  });

  it("lists sessions with first and last activity", () => {
    const store = openSessionStore(cap);
    store.append(entry({ sessionId: "listA", createdAt: 1000 }));
    store.append(entry({ sessionId: "listA", createdAt: 2000 }));
    store.append(entry({ sessionId: "listB", createdAt: 1500 }));
    const sessions = store.listSessions();
    const a = sessions.find((s) => s.sessionId === "listA");
    expect(a?.startedAt).toBe(1000);
    expect(a?.lastAt).toBe(2000);
    expect(sessions.some((s) => s.sessionId === "listB")).toBe(true);
    store.close();
  });
});
