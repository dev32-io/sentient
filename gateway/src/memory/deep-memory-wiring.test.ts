import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayLogger } from "../logging/logger.js";
import type { DeepMemoryClient } from "./deep-memory-client.js";
import { createDeepMemoryApp, createSessionSpark } from "./deep-memory-wiring.js";
import type { MemoryRetriever, SparkTurn } from "./memory-retriever.js";
import type { MemoryConfig, MemoryStore } from "./memory-store.js";

// createIndexSync only reads cfg on enqueue/flush/rebuild, never at construction,
// and the store is never touched at construction either — both are inert here.
const CFG = { spark: { raw_chunks: false } } as unknown as MemoryConfig;
const STORE = {} as unknown as MemoryStore;

const HEALTH_OK = { status: "ok", version: "1", embeddingModel: null, indexSchemaVersion: 1 } as const;

let indexDir: string;

beforeEach(async () => {
  indexDir = mkdtempSync(join(tmpdir(), "deep-wiring-"));
  await createGatewayLogger({ testSink: () => {}, logLevel: "debug" });
});

afterEach(() => rmSync(indexDir, { recursive: true, force: true }));

function scopeInput(scopeId: string): { scopeId: string; indexDir: string; indexPath: string; store: MemoryStore } {
  return { scopeId, indexDir, indexPath: join(indexDir, "index.db"), store: STORE };
}

describe("createDeepMemoryApp — scope registration", () => {
  it("registers a scope BEFORE its first search resolves (post-boot user)", async () => {
    const order: string[] = [];
    let releaseRegister: () => void = () => {};
    const registered = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    const client = {
      registerScope: async () => {
        order.push("register-start");
        await registered;
        order.push("register-done");
        return { ok: true as const, value: undefined };
      },
      search: async () => {
        order.push("search");
        return { ok: true as const, value: [] };
      },
      upsert: async () => ({ ok: true as const, value: undefined }),
      setStatus: async () => ({ ok: true as const, value: undefined }),
      purge: async () => ({ ok: true as const, value: undefined }),
      rebuild: async () => ({ ok: true as const, value: undefined }),
      health: async () => ({ ok: true as const, value: HEALTH_OK }),
    } as unknown as DeepMemoryClient;

    const app = createDeepMemoryApp({
      baseUrl: "http://127.0.0.1:0",
      adminToken: "a",
      dataToken: "d",
      requestTimeoutMs: 1000,
      cfg: CFG,
      client,
      pollMs: 0,
    });

    // A scope created AFTER boot (its first session build) registers on demand.
    const scope = app.ensureScope(scopeInput("user:u_post_boot"));
    const searchPromise = scope.client.search({ scopeIds: ["user:u_post_boot"], query: "q", k: 5 });

    // Registration is in flight and the gated search is BLOCKED behind it.
    await Promise.resolve();
    expect(order).toEqual(["register-start"]);

    releaseRegister();
    await searchPromise;
    expect(order).toEqual(["register-start", "register-done", "search"]);
    app.stop();
  });

  it("registers each scope exactly once and memoizes the wiring (idempotent)", async () => {
    let registerCount = 0;
    const client = {
      registerScope: async () => {
        registerCount += 1;
        return { ok: true as const, value: undefined };
      },
      search: async () => ({ ok: true as const, value: [] }),
      upsert: async () => ({ ok: true as const, value: undefined }),
      setStatus: async () => ({ ok: true as const, value: undefined }),
      purge: async () => ({ ok: true as const, value: undefined }),
      rebuild: async () => ({ ok: true as const, value: undefined }),
      health: async () => ({ ok: true as const, value: HEALTH_OK }),
    } as unknown as DeepMemoryClient;

    const app = createDeepMemoryApp({
      baseUrl: "http://127.0.0.1:0",
      adminToken: "a",
      dataToken: "d",
      requestTimeoutMs: 1000,
      cfg: CFG,
      client,
      pollMs: 0,
    });

    const first = app.ensureScope(scopeInput("user:u1"));
    const second = app.ensureScope(scopeInput("user:u1"));
    // A DIFFERENT scope registers independently — post-boot users each get one.
    app.ensureScope(scopeInput("user:u2"));

    await first.client.search({ scopeIds: ["user:u1"], query: "q", k: 5 });
    await second.client.search({ scopeIds: ["user:u1"], query: "q", k: 5 });

    expect(first).toBe(second); // memoized wiring — single-writer outbox
    expect(registerCount).toBe(2); // once per distinct scope, never per session
    app.stop();
  });
});

// A retriever double: records the SparkTurn it is handed and memoizes a block by
// turnId (matching the real `computeSpark` + `cachedFor` contract).
function fakeRetriever(): { retriever: MemoryRetriever; calls: SparkTurn[] } {
  const memo = new Map<string, string>();
  const calls: SparkTurn[] = [];
  const retriever: MemoryRetriever = {
    async computeSpark(turn) {
      calls.push(turn);
      const block = `block:${turn.utterance}`;
      memo.set(turn.turnId, block);
      return block;
    },
    cachedFor(turnId) {
      return memo.get(turnId) ?? null;
    },
  };
  return { retriever, calls };
}

describe("createSessionSpark", () => {
  it("primes on the utterance and exposes the cached block via current()", async () => {
    const { retriever, calls } = fakeRetriever();
    const spark = createSessionSpark(retriever, {
      userId: "u1",
      scopeIds: ["user:u1"],
      childPrincipal: false,
      sessionId: "sess-1",
    });

    expect(spark.current()).toBeNull(); // nothing primed yet

    await spark.prime("t1", "where did we go in July");
    expect(spark.current()).toBe("block:where did we go in July");

    // The SparkTurn carries the REAL sessionId (not the turn id) for the gate.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sessionId).toBe("sess-1");
    expect(calls[0]?.scopeIds).toEqual(["user:u1"]);
    expect(calls[0]?.childPrincipal).toBe(false);
  });

  it("is a no-op on an empty utterance (a background-completion trigger turn)", async () => {
    const { retriever, calls } = fakeRetriever();
    const spark = createSessionSpark(retriever, {
      userId: "u1",
      scopeIds: ["user:u1"],
      childPrincipal: false,
      sessionId: "sess-1",
    });

    await spark.prime("t2", "   ");
    expect(calls).toHaveLength(0);
    expect(spark.current()).toBeNull();
  });
});
