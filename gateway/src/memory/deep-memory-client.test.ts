// DeepMemoryClient wire-contract tests (Memory System spec §5.2/§5.4). The
// client is a typed HTTP boundary onto the DeepMemoryService; these tests pin
// the contract with a local mock HTTP server (Bun.serve) — no real service, no
// network beyond loopback. They assert: deadline → timeout, 409 →
// rebuild_required, connection-refused → unavailable, happy search shape, and
// per-plane auth-token routing (admin vs data).

import { afterEach, describe, expect, it } from "bun:test";
import { type IndexEntry, createDeepMemoryClient } from "./deep-memory-client.js";

type Server = ReturnType<typeof Bun.serve>;

const ADMIN_TOKEN = "admin-secret-token";
const DATA_TOKEN = "data-secret-token";

let server: Server | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

function startServer(handler: Handler): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      return handler(req, new URL(req.url));
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function makeClient(baseUrl: string, requestTimeoutMs = 5000) {
  return createDeepMemoryClient({
    baseUrl,
    adminToken: ADMIN_TOKEN,
    dataToken: DATA_TOKEN,
    requestTimeoutMs,
  });
}

function sampleEntry(): IndexEntry {
  return {
    id: "hash-abc",
    kind: "episode-summary",
    text: "canonical episode text",
    timestamp: "2026-08-08T10:00:00.000Z",
    scope: "user:alice",
    sourceRef: { file: "journal/2026-08-08.md", heading: "session s1" },
    provenance: "user",
    status: "active",
    createdAt: "2026-08-08T10:00:00.000Z",
    statusChangedAt: "2026-08-08T10:00:00.000Z",
  };
}

describe("createDeepMemoryClient", () => {
  it("returns timeout kind when the service hangs past the deadline", async () => {
    const baseUrl = startServer(() => new Promise<Response>(() => {}));
    const client = makeClient(baseUrl, 50);

    const started = Date.now();
    const result = await client.search({ scopeIds: ["user:alice"], query: "q", k: 3 });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("timeout");
    }
    // Deadline was honored well within a generous budget.
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns rebuild_required when the service answers 409", async () => {
    const baseUrl = startServer(
      () => new Response(JSON.stringify({ error: "index schema mismatch" }), { status: 409 }),
    );
    const client = makeClient(baseUrl);

    const result = await client.search({ scopeIds: ["user:alice"], query: "q", k: 3 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rebuild_required");
    }
  });

  it("returns refused carrying the server error string on a 4xx", async () => {
    const baseUrl = startServer(() => new Response(JSON.stringify({ error: "unknown scope id" }), { status: 400 }));
    const client = makeClient(baseUrl);

    const result = await client.search({ scopeIds: ["user:ghost"], query: "q", k: 3 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("refused");
      expect(result.error.message).toContain("unknown scope id");
    }
  });

  it("returns unavailable when the connection is refused", async () => {
    // Port 1 has no listener — connect fails fast with ECONNREFUSED.
    const client = makeClient("http://127.0.0.1:1", 2000);

    const result = await client.health();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("unavailable");
    }
  });

  it("returns Hit[] with similarity and rank on a happy search", async () => {
    const hits = [
      { entry: sampleEntry(), similarity: 0.91, rank: 1 },
      { entry: { ...sampleEntry(), id: "hash-def" }, similarity: 0.77, rank: 2 },
    ];
    const baseUrl = startServer(() => new Response(JSON.stringify({ hits }), { status: 200 }));
    const client = makeClient(baseUrl);

    const result = await client.search({ scopeIds: ["user:alice"], query: "cabin trip", k: 5 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.similarity).toBe(0.91);
      expect(result.value[0]?.rank).toBe(1);
      expect(result.value[0]?.entry.id).toBe("hash-abc");
      expect(result.value[1]?.rank).toBe(2);
    }
  });

  it("sends the admin token on an admin-plane call (registerScope)", async () => {
    let seenAuth = "";
    let seenPath = "";
    const baseUrl = startServer((req, url) => {
      seenAuth = req.headers.get("Authorization") ?? "";
      seenPath = url.pathname;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = makeClient(baseUrl);

    const result = await client.registerScope("user:alice", "/index/path");

    expect(result.ok).toBe(true);
    expect(seenPath).toBe("/register-scope");
    expect(seenAuth).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it("sends the data token on a data-plane call (upsert)", async () => {
    let seenAuth = "";
    let seenPath = "";
    const baseUrl = startServer((req, url) => {
      seenAuth = req.headers.get("Authorization") ?? "";
      seenPath = url.pathname;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = makeClient(baseUrl);

    const result = await client.upsert("user:alice", [sampleEntry()]);

    expect(result.ok).toBe(true);
    expect(seenPath).toBe("/upsert");
    expect(seenAuth).toBe(`Bearer ${DATA_TOKEN}`);
  });

  it("sends the data token on health (no admin secret leaks to the health plane)", async () => {
    let seenAuth = "";
    let seenPath = "";
    const baseUrl = startServer((req, url) => {
      seenAuth = req.headers.get("Authorization") ?? "";
      seenPath = url.pathname;
      return new Response(
        JSON.stringify({
          status: "ok",
          version: "0.1.0",
          embeddingModel: "mlx-embed-v1",
          indexSchemaVersion: 3,
        }),
        { status: 200 },
      );
    });
    const client = makeClient(baseUrl);

    const result = await client.health();

    expect(result.ok).toBe(true);
    expect(seenPath).toBe("/health");
    expect(seenAuth).toBe(`Bearer ${DATA_TOKEN}`);
  });
});
