# Phase 1.4 — Gateway-Hosted MCP Server

> **Parent plan:** `2026-04-21-hermes-phase1-overview.md`
> **Previous:** `2026-04-21-hermes-phase1.3-tts-chain.md`

**Goal:** a gateway-hosted MCP server exposing tools that need reach-back into gateway state. Hermes dials it like any other MCP server. Tools for v1: `identify_user`, `pause_audio`, `resume_audio`, `set_channel`. Transport: stdio over a shared Unix socket (`/run/sentient/mcp.sock`).

**Builds on:** Phase 1.1 (config schema for `hermes.mcp_host`), 1.2 (live HermesClient), 1.3 (`SessionAudioController` remains the audio authority).

**Spec reference:** v4 §5.13, §8.2.

---

## 1. Context and prerequisites

### Why gateway-hosted MCP

Tools like `pause_audio` or `identify_user` must mutate gateway state (the audio controller, the session-router binding). Shipping them as an MCP server inside our gateway lets Hermes call them via the standard MCP protocol while keeping the implementation in-process for zero-latency reach-back.

### Transport decision

Per D-14, we use stdio-over-Unix-socket. Flow:
1. Gateway starts a Unix socket listener at `/run/sentient/mcp.sock` on startup.
2. Hermes's profile `config.yaml` has:
   ```yaml
   mcp_servers:
     gateway:
       command: nc
       args: ["-U", "/run/sentient/mcp.sock"]
   ```
3. Docker compose mounts the socket into each Hermes container so `nc -U` can reach it.
4. MCP protocol speaks JSON-RPC 2.0 over stdio. We implement the server side.

### MCP protocol subset we need

For v1 we only implement:
- `initialize` (handshake)
- `tools/list` (report available tools)
- `tools/call` (dispatch a tool call)

We do NOT need:
- `resources/list|read` (not using MCP resources)
- `prompts/list|get` (not using MCP prompts)
- `sampling/*` (not proxying LLM calls)

---

## Task 1.4.1 — MCP server core (protocol + stdio framing)

**Files:**
- Create: `gateway/src/mcp-host/mcp-protocol.ts`
- Create: `gateway/src/mcp-host/mcp-protocol.test.ts`
- Create: `gateway/src/mcp-host/mcp-server.ts`
- Create: `gateway/src/mcp-host/mcp-server.test.ts`

### Step 1.4.1a: Protocol types + JSON-RPC framing

- [ ] Create `gateway/src/mcp-host/mcp-protocol.ts`:

```typescript
import { z } from "zod";

/** JSON-RPC 2.0 envelope */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool definition */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** MCP tools/call result shape */
export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** JSON-RPC error codes per spec */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/**
 * Parse a single \n-delimited JSON-RPC message line.
 * Returns a request or an object indicating parse failure.
 */
export function parseRpcLine(
  line: string,
): { ok: true; req: JsonRpcRequest } | { ok: false; error: JsonRpcResponse } {
  try {
    const raw = JSON.parse(line);
    const p = jsonRpcRequestSchema.safeParse(raw);
    if (!p.success) {
      const id = typeof raw === "object" && raw !== null ? (raw as { id?: string | number }).id ?? null : null;
      return {
        ok: false,
        error: {
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: RPC_INVALID_REQUEST, message: "invalid request shape" },
        },
      };
    }
    return { ok: true, req: p.data };
  } catch {
    return {
      ok: false,
      error: {
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_PARSE_ERROR, message: "parse error" },
      },
    };
  }
}
```

### Step 1.4.1b: Protocol tests

- [ ] Create `gateway/src/mcp-host/mcp-protocol.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseRpcLine, RPC_PARSE_ERROR, RPC_INVALID_REQUEST } from "./mcp-protocol";

describe("parseRpcLine", () => {
  it("parses a valid request", () => {
    const r = parseRpcLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(r.ok).toBe(true);
  });

  it("handles malformed JSON", () => {
    const r = parseRpcLine("{not valid");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error?.code).toBe(RPC_PARSE_ERROR);
  });

  it("rejects missing method", () => {
    const r = parseRpcLine('{"jsonrpc":"2.0","id":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error?.code).toBe(RPC_INVALID_REQUEST);
  });

  it("accepts notifications (no id)", () => {
    const r = parseRpcLine('{"jsonrpc":"2.0","method":"notify"}');
    expect(r.ok).toBe(true);
  });
});
```

### Step 1.4.1c: Pure server logic (transport-agnostic)

This function takes a request and a tool registry and returns a response. Pure — no I/O. Easy to test.

- [ ] Create `gateway/src/mcp-host/mcp-server.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ToolCallResult,
  type ToolDefinition,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
} from "./mcp-protocol";

const log = createLogger(["sentient.gateway.mcp-host", "server"]);

export interface ToolHandler {
  def: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolCallResult>;
}

export interface ToolContext {
  /** Session id for the Hermes container invoking the tool. Phase 1.7+. */
  sessionId: string | null;
  /** Short-form user identifier, if known. */
  userId: string | null;
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  get(name: string): ToolHandler | null;
}

export interface McpServerDeps {
  registry: ToolRegistry;
  /** Resolve a per-connection ToolContext. Phase 1.4 stub returns null/null. */
  contextFor(connectionId: string): ToolContext;
}

/**
 * Handle one JSON-RPC request. Pure (no I/O). Caller owns the transport.
 */
export async function handleRpc(
  req: JsonRpcRequest,
  connectionId: string,
  deps: McpServerDeps,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "sentient-gateway-mcp",
          version: "1.0.0",
        },
      },
    };
  }

  if (req.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: deps.registry.list() },
    };
  }

  if (req.method === "tools/call") {
    const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: RPC_INVALID_PARAMS, message: "missing tool name" },
      };
    }
    const handler = deps.registry.get(params.name);
    if (!handler) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: RPC_METHOD_NOT_FOUND, message: `unknown tool: ${params.name}` },
      };
    }
    const args =
      typeof params.arguments === "object" && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
    try {
      const ctx = deps.contextFor(connectionId);
      const result = await handler.run(args, ctx);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug("tools/call.error", { tool: params.name, err: msg });
      return {
        jsonrpc: "2.0",
        id,
        error: { code: RPC_INTERNAL_ERROR, message: msg },
      };
    }
  }

  // Notification (no id) — no response.
  if (id === null || id === undefined) return null;

  return {
    jsonrpc: "2.0",
    id,
    error: { code: RPC_METHOD_NOT_FOUND, message: `unknown method: ${req.method}` },
  };
}
```

### Step 1.4.1d: Server tests with an in-memory registry

- [ ] Create `gateway/src/mcp-host/mcp-server.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { handleRpc } from "./mcp-server";
import type { ToolHandler, ToolRegistry } from "./mcp-server";

function makeRegistry(handlers: ToolHandler[]): ToolRegistry {
  const map = new Map(handlers.map((h) => [h.def.name, h]));
  return {
    list() {
      return handlers.map((h) => h.def);
    },
    get(name) {
      return map.get(name) ?? null;
    },
  };
}

describe("handleRpc", () => {
  const deps = {
    registry: makeRegistry([
      {
        def: {
          name: "echo",
          description: "returns input",
          inputSchema: {
            type: "object" as const,
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        async run(args) {
          return { content: [{ type: "text" as const, text: String(args.text) }] };
        },
      },
    ]),
    contextFor: () => ({ sessionId: null, userId: null }),
  };

  it("responds to initialize", async () => {
    const res = await handleRpc(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      "conn1",
      deps,
    );
    expect(res?.result).toMatchObject({ serverInfo: { name: "sentient-gateway-mcp" } });
  });

  it("lists tools", async () => {
    const res = await handleRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      "conn1",
      deps,
    );
    const r = res?.result as { tools: Array<{ name: string }> };
    expect(r.tools[0]?.name).toBe("echo");
  });

  it("calls an existing tool", async () => {
    const res = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      "conn1",
      deps,
    );
    expect(res?.result).toMatchObject({
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("returns error for unknown tool", async () => {
    const res = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "nope" },
      },
      "conn1",
      deps,
    );
    expect(res?.error?.code).toBe(-32601);
  });

  it("returns null for notifications", async () => {
    const res = await handleRpc(
      { jsonrpc: "2.0", method: "notify_something" },
      "conn1",
      deps,
    );
    expect(res).toBeNull();
  });
});
```

- [ ] Verify + commit:

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- mcp-protocol mcp-server
git add gateway/src/mcp-host/mcp-protocol.ts gateway/src/mcp-host/mcp-protocol.test.ts gateway/src/mcp-host/mcp-server.ts gateway/src/mcp-host/mcp-server.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp-host): JSON-RPC 2.0 server core

Pure, transport-agnostic MCP server. Handles initialize, tools/list,
tools/call. Zod-validated requests; typed error codes per JSON-RPC spec.
Unit tests drive the pure handleRpc() with an in-memory registry.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.4.2 — Unix-socket listener

**Files:**
- Create: `gateway/src/mcp-host/unix-socket-listener.ts`
- Create: `gateway/src/mcp-host/unix-socket-listener.test.ts`

### Step 1.4.2a: Implementation

Bun supports Unix sockets via `Bun.listen`. Each connection is a newline-delimited JSON-RPC stream.

- [ ] Create `gateway/src/mcp-host/unix-socket-listener.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import type { Socket } from "bun";
import { parseRpcLine } from "./mcp-protocol";
import { handleRpc, type McpServerDeps } from "./mcp-server";

const log = createLogger(["sentient.gateway.mcp-host", "unix-listener"]);

export interface UnixSocketListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createUnixSocketListener(
  socketPath: string,
  deps: McpServerDeps,
): UnixSocketListener {
  let server: ReturnType<typeof Bun.listen<unknown>> | null = null;
  let connSeq = 0;

  return {
    async start() {
      // Remove stale socket if present (Bun will not auto-clean).
      try {
        await Bun.file(socketPath).exists();
        await Bun.write(socketPath, ""); // truncate; ignored on fresh
      } catch {
        /* ignore */
      }
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }

      server = Bun.listen<{ id: string; buffer: string }>({
        unix: socketPath,
        socket: {
          open(socket: Socket<{ id: string; buffer: string }>) {
            const id = `conn-${++connSeq}`;
            socket.data = { id, buffer: "" };
            log.debug("open", { connectionId: id });
          },
          async data(socket, chunk: Buffer | Uint8Array | string) {
            const data = socket.data;
            if (!data) return;
            data.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            let idx: number;
            while ((idx = data.buffer.indexOf("\n")) !== -1) {
              const line = data.buffer.slice(0, idx);
              data.buffer = data.buffer.slice(idx + 1);
              if (line.trim().length === 0) continue;
              const parsed = parseRpcLine(line);
              if (!parsed.ok) {
                socket.write(JSON.stringify(parsed.error) + "\n");
                continue;
              }
              const res = await handleRpc(parsed.req, data.id, deps);
              if (res) socket.write(JSON.stringify(res) + "\n");
            }
          },
          close(socket) {
            log.debug("close", { connectionId: socket.data?.id });
          },
          error(_socket, err: Error) {
            log.debug("error", { err: err.message });
          },
        },
      });
      log.debug("start", { socketPath });
    },
    async stop() {
      if (server) {
        server.stop(true);
        server = null;
      }
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
      log.debug("stop", { socketPath });
    },
  };
}
```

### Step 1.4.2b: Test (smoke test socket round-trip)

- [ ] Create `gateway/src/mcp-host/unix-socket-listener.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { createUnixSocketListener } from "./unix-socket-listener";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

const SOCKET_PATH = join(tmpdir(), `sentient-mcp-test-${process.pid}.sock`);

const listener = createUnixSocketListener(SOCKET_PATH, {
  registry: {
    list() {
      return [
        {
          name: "ping",
          description: "pings",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ];
    },
    get(name) {
      if (name !== "ping") return null;
      return {
        def: {
          name: "ping",
          description: "pings",
          inputSchema: { type: "object" as const, properties: {} },
        },
        async run() {
          return { content: [{ type: "text" as const, text: "pong" }] };
        },
      };
    },
  },
  contextFor: () => ({ sessionId: null, userId: null }),
});

describe("UnixSocketListener", () => {
  afterAll(async () => {
    await listener.stop();
  });

  it("round-trips tools/list over unix socket", async () => {
    await listener.start();
    const response: string = await new Promise((resolve, reject) => {
      const socket = connect(SOCKET_PATH);
      let buf = "";
      socket.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        if (buf.includes("\n")) {
          resolve(buf);
          socket.end();
        }
      });
      socket.on("error", reject);
      socket.on("connect", () => {
        socket.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      });
    });
    const parsed = JSON.parse(response.trim()) as { result: { tools: Array<{ name: string }> } };
    expect(parsed.result.tools[0]?.name).toBe("ping");
  });
});
```

### Step 1.4.2c: Verify + commit

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- unix-socket-listener
git add gateway/src/mcp-host/unix-socket-listener.ts gateway/src/mcp-host/unix-socket-listener.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp-host): Unix-socket listener for JSON-RPC framing

Bun.listen-based stdio-style transport. Newline-delimited JSON-RPC
messages. Per-connection buffer; clean start()/stop() lifecycle.
Smoke test round-trips tools/list over a tmpdir socket.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.4.3 — Tool registry + v1 tools

**Files:**
- Create: `gateway/src/mcp-host/tool-registry.ts`
- Create: `gateway/src/mcp-host/tool-registry.test.ts`
- Create: `gateway/src/mcp-host/tools/identify-user.ts`
- Create: `gateway/src/mcp-host/tools/identify-user.test.ts`
- Create: `gateway/src/mcp-host/tools/audio-tools.ts` (pause_audio / resume_audio)
- Create: `gateway/src/mcp-host/tools/audio-tools.test.ts`
- Create: `gateway/src/mcp-host/tools/set-channel.ts`
- Create: `gateway/src/mcp-host/tools/set-channel.test.ts`

### Step 1.4.3a: Registry

- [ ] Create `gateway/src/mcp-host/tool-registry.ts`:

```typescript
import type { ToolHandler, ToolRegistry } from "./mcp-server";

export function createToolRegistry(handlers: ToolHandler[]): ToolRegistry {
  const map = new Map(handlers.map((h) => [h.def.name, h]));
  return {
    list() {
      return handlers.map((h) => h.def);
    },
    get(name) {
      return map.get(name) ?? null;
    },
  };
}
```

- [ ] Create trivial test `gateway/src/mcp-host/tool-registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createToolRegistry } from "./tool-registry";

const dummyHandler = {
  def: {
    name: "x",
    description: "",
    inputSchema: { type: "object" as const, properties: {} },
  },
  async run() {
    return { content: [{ type: "text" as const, text: "" }] };
  },
};

describe("createToolRegistry", () => {
  it("lists and gets handlers", () => {
    const r = createToolRegistry([dummyHandler]);
    expect(r.list()).toHaveLength(1);
    expect(r.get("x")?.def.name).toBe("x");
    expect(r.get("missing")).toBeNull();
  });
});
```

### Step 1.4.3b: `identify_user` tool

- [ ] Create `gateway/src/mcp-host/tools/identify-user.ts`:

```typescript
import type { ToolHandler } from "../mcp-server";
import { createLogger } from "@sentient/logging";
import type { SessionRouter } from "../../session-router";
import type { HermesConfig } from "@sentient/config/schemas";

const log = createLogger(["sentient.gateway.mcp-host", "identify-user"]);

export interface IdentifyUserDeps {
  router: SessionRouter;
  config: HermesConfig;
  /** Resolves the session id from an MCP connection id. Phase 1.7+ fills this. */
  sessionForConnection(connectionId: string): string | null;
}

export function createIdentifyUserTool(deps: IdentifyUserDeps): ToolHandler {
  return {
    def: {
      name: "identify_user",
      description:
        "Rebinds the current session to a different household member. Call when the user says 'I am X' where X is a known user.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The user id to bind to (e.g., 'alice', 'bob')." },
        },
        required: ["name"],
      },
    },
    async run(args, ctx) {
      const rawName = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
      if (!rawName) {
        return {
          isError: true,
          content: [{ type: "text", text: "identify_user: missing name argument" }],
        };
      }
      const knownUsers = Object.keys(deps.config.profiles).filter(
        (id) => !id.startsWith("_") && deps.config.profiles[id]?.enabled,
      );
      if (!knownUsers.includes(rawName)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `identify_user: unknown user "${rawName}". Known users: ${knownUsers.join(", ")}`,
            },
          ],
        };
      }
      // We need a session id to rebind. In Phase 1.4 the sessionForConnection
      // resolver may be a stub — if it returns null, we return an advisory
      // success so the tool is still observable to the model.
      const sessionId = deps.sessionForConnection(ctx.sessionId ?? "unknown");
      if (!sessionId) {
        log.debug("identify_user.no-session", { name: rawName });
        return {
          content: [
            {
              type: "text",
              text: `identify_user: would rebind to ${rawName} (session binding deferred to Phase 1.7)`,
            },
          ],
        };
      }
      deps.router.rebind(sessionId, rawName);
      log.debug("identify_user.ok", { sessionId, name: rawName });
      return {
        content: [{ type: "text", text: `rebound to ${rawName}` }],
      };
    },
  };
}
```

- [ ] Create `gateway/src/mcp-host/tools/identify-user.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createIdentifyUserTool } from "./identify-user";
import type { HermesConfig } from "@sentient/config/schemas";

const baseConfig: HermesConfig = {
  profiles: {
    alice: {
      container_name: "x", port: 8643, api_key_env: "K", url: "http://x", profile_dir: ".", role: "user", enabled: true,
    },
    bob: {
      container_name: "y", port: 8644, api_key_env: "K2", url: "http://y", profile_dir: ".", role: "user", enabled: true,
    },
    _steward: {
      container_name: "z", port: 8649, api_key_env: "K3", url: "http://z", profile_dir: ".", role: "steward", enabled: false,
    },
  },
} as unknown as HermesConfig;

const fakeRouter = {
  bind: vi.fn(),
  release: vi.fn(),
  rebind: vi.fn(),
  get: vi.fn(),
};

describe("identify_user tool", () => {
  it("rejects missing name", async () => {
    const t = createIdentifyUserTool({
      router: fakeRouter,
      config: baseConfig,
      sessionForConnection: () => "s1",
    });
    const r = await t.run({}, { sessionId: "conn1", userId: null });
    expect(r.isError).toBe(true);
  });

  it("rejects unknown user", async () => {
    const t = createIdentifyUserTool({
      router: fakeRouter,
      config: baseConfig,
      sessionForConnection: () => "s1",
    });
    const r = await t.run({ name: "carol" }, { sessionId: "conn1", userId: null });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/alice/);
  });

  it("rebinds for known user", async () => {
    const t = createIdentifyUserTool({
      router: fakeRouter,
      config: baseConfig,
      sessionForConnection: () => "s1",
    });
    const r = await t.run({ name: "bob" }, { sessionId: "conn1", userId: null });
    expect(r.isError).toBeUndefined();
    expect(fakeRouter.rebind).toHaveBeenCalledWith("s1", "bob");
  });

  it("ignores steward role", async () => {
    const t = createIdentifyUserTool({
      router: fakeRouter,
      config: baseConfig,
      sessionForConnection: () => "s1",
    });
    const r = await t.run({ name: "_steward" }, { sessionId: "conn1", userId: null });
    expect(r.isError).toBe(true);
  });
});
```

### Step 1.4.3c: Audio tools (pause / resume)

These require `SessionAudioController` reach-back. The exact interface varies; adapt to what's already in `gateway/src/session-handlers/` or wherever the audio controller lives.

- [ ] Create `gateway/src/mcp-host/tools/audio-tools.ts`:

```typescript
import type { ToolHandler } from "../mcp-server";

export interface AudioControls {
  pause(sessionId: string, reason?: string): Promise<void>;
  resume(sessionId: string, reason?: string): Promise<void>;
}

export interface AudioToolsDeps {
  audio: AudioControls;
  sessionForConnection(connectionId: string): string | null;
}

export function createPauseAudioTool(deps: AudioToolsDeps): ToolHandler {
  return {
    def: {
      name: "pause_audio",
      description: "Pauses the current TTS playback on the user's device. Optional reason describes why.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
      },
    },
    async run(args, ctx) {
      const sessionId = deps.sessionForConnection(ctx.sessionId ?? "");
      if (!sessionId) {
        return {
          isError: true,
          content: [{ type: "text", text: "pause_audio: no active session for connection" }],
        };
      }
      await deps.audio.pause(sessionId, typeof args.reason === "string" ? args.reason : undefined);
      return { content: [{ type: "text", text: "audio paused" }] };
    },
  };
}

export function createResumeAudioTool(deps: AudioToolsDeps): ToolHandler {
  return {
    def: {
      name: "resume_audio",
      description: "Resumes previously paused TTS playback.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
      },
    },
    async run(args, ctx) {
      const sessionId = deps.sessionForConnection(ctx.sessionId ?? "");
      if (!sessionId) {
        return {
          isError: true,
          content: [{ type: "text", text: "resume_audio: no active session" }],
        };
      }
      await deps.audio.resume(sessionId, typeof args.reason === "string" ? args.reason : undefined);
      return { content: [{ type: "text", text: "audio resumed" }] };
    },
  };
}
```

- [ ] Tests in `gateway/src/mcp-host/tools/audio-tools.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createPauseAudioTool, createResumeAudioTool } from "./audio-tools";

const audio = { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
const sessionResolver = vi.fn(() => "s1");

describe("pause_audio / resume_audio", () => {
  it("pause: calls audio.pause with session + reason", async () => {
    const t = createPauseAudioTool({ audio, sessionForConnection: sessionResolver });
    const r = await t.run({ reason: "user spoke" }, { sessionId: "conn1", userId: null });
    expect(audio.pause).toHaveBeenCalledWith("s1", "user spoke");
    expect(r.isError).toBeUndefined();
  });

  it("resume: calls audio.resume", async () => {
    const t = createResumeAudioTool({ audio, sessionForConnection: sessionResolver });
    await t.run({}, { sessionId: "conn1", userId: null });
    expect(audio.resume).toHaveBeenCalled();
  });

  it("errors when no session", async () => {
    const t = createPauseAudioTool({
      audio,
      sessionForConnection: () => null,
    });
    const r = await t.run({}, { sessionId: "conn1", userId: null });
    expect(r.isError).toBe(true);
  });
});
```

### Step 1.4.3d: `set_channel` tool

- [ ] Create `gateway/src/mcp-host/tools/set-channel.ts`:

```typescript
import type { ToolHandler } from "../mcp-server";

export interface ChannelControls {
  setChannel(sessionId: string, channel: "voice" | "text"): Promise<void>;
}

export interface SetChannelDeps {
  controls: ChannelControls;
  sessionForConnection(connectionId: string): string | null;
}

export function createSetChannelTool(deps: SetChannelDeps): ToolHandler {
  return {
    def: {
      name: "set_channel",
      description:
        "Sets the user's preferred channel. 'voice' = speak responses; 'text' = suppress TTS.",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", enum: ["voice", "text"] },
        },
        required: ["channel"],
      },
    },
    async run(args, ctx) {
      const channel = args.channel;
      if (channel !== "voice" && channel !== "text") {
        return {
          isError: true,
          content: [{ type: "text", text: "set_channel: channel must be 'voice' or 'text'" }],
        };
      }
      const sessionId = deps.sessionForConnection(ctx.sessionId ?? "");
      if (!sessionId) {
        return {
          isError: true,
          content: [{ type: "text", text: "set_channel: no active session" }],
        };
      }
      await deps.controls.setChannel(sessionId, channel);
      return { content: [{ type: "text", text: `channel set to ${channel}` }] };
    },
  };
}
```

- [ ] Matching test `gateway/src/mcp-host/tools/set-channel.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createSetChannelTool } from "./set-channel";

describe("set_channel", () => {
  it("rejects invalid channel", async () => {
    const t = createSetChannelTool({
      controls: { setChannel: vi.fn() },
      sessionForConnection: () => "s1",
    });
    const r = await t.run({ channel: "bogus" }, { sessionId: "conn1", userId: null });
    expect(r.isError).toBe(true);
  });

  it("invokes controls for voice", async () => {
    const setChannel = vi.fn(async () => {});
    const t = createSetChannelTool({
      controls: { setChannel },
      sessionForConnection: () => "s1",
    });
    await t.run({ channel: "voice" }, { sessionId: "conn1", userId: null });
    expect(setChannel).toHaveBeenCalledWith("s1", "voice");
  });
});
```

### Step 1.4.3e: Verify + commit

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- mcp-host
git add gateway/src/mcp-host/
git commit -m "$(cat <<'EOF'
feat(mcp-host): v1 gateway tools (identify_user, pause_audio, resume_audio, set_channel)

Each tool is a ToolHandler consuming a deps object and returning a
ToolCallResult. Pure wiring — effect is delegated to SessionRouter or
audio/channel controllers. Unit tests cover happy path + missing-session
+ validation errors.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.4.4 — Wire into gateway startup

**Files:**
- Modify: gateway entry point (wherever session manager / audio controller is instantiated)

This step ties the MCP server into gateway lifecycle. Exact file depends on the existing code. Conceptually:

1. On gateway startup: construct `SessionRouter`, `ConversationMirror`, `TaskMirror`, audio/channel controller adapters.
2. Build `ToolRegistry` with the four v1 tools.
3. Start `UnixSocketListener` on `/run/sentient/mcp.sock`.
4. On shutdown: stop the listener.

### Step 1.4.4a: Find the entry point

- [ ] Locate where the gateway WS server is initialized. Common names: `gateway/src/server.ts`, `gateway/src/index.ts`, `gateway/src/main.ts`, or similar. Run:

```bash
grep -lrn "Bun.serve\|createSessionManager\|WebSocketHandler" gateway/src/ | head -5
```

Read the top-most one.

### Step 1.4.4b: Add MCP server bootstrap

- [ ] In that entry point (adapt to actual code), after session/audio controllers are ready:

```typescript
import { createToolRegistry } from "./mcp-host/tool-registry";
import { createUnixSocketListener } from "./mcp-host/unix-socket-listener";
import { createIdentifyUserTool } from "./mcp-host/tools/identify-user";
import { createPauseAudioTool, createResumeAudioTool } from "./mcp-host/tools/audio-tools";
import { createSetChannelTool } from "./mcp-host/tools/set-channel";

// ... after we have `config`, `sessionRouter`, `audioAdapter`, `channelAdapter` ...

// Stub: Phase 1.4 has no per-connection session binding. Phase 1.7 wires this.
function sessionForConnection(_connectionId: string): string | null {
  return null;
}

const registry = createToolRegistry([
  createIdentifyUserTool({ router: sessionRouter, config: config.hermes!, sessionForConnection }),
  createPauseAudioTool({ audio: audioAdapter, sessionForConnection }),
  createResumeAudioTool({ audio: audioAdapter, sessionForConnection }),
  createSetChannelTool({ controls: channelAdapter, sessionForConnection }),
]);

const mcpListener = createUnixSocketListener(
  config.hermes?.mcp_host.socket_path ?? "/run/sentient/mcp.sock",
  { registry, contextFor: () => ({ sessionId: null, userId: null }) },
);

await mcpListener.start();

// On shutdown:
// await mcpListener.stop();
```

- [ ] If `audioAdapter` / `channelAdapter` don't yet exist, write thin adapters that wrap the existing `SessionAudioController` / session state. They just need to expose `pause/resume/setChannel` with the `(sessionId, ...)` shape.

### Step 1.4.4c: Docker-compose socket mount

- [ ] Edit `deploy/docker/docker-compose.yml`. For `gateway` service, ensure the socket dir is a writable bind-mount:

```yaml
services:
  gateway:
    # ...
    volumes:
      - ./run/sentient:/run/sentient
      # ... other mounts ...
```

- [ ] For `hermes-alice` (and any future Hermes service), mount the SAME socket dir read-write (Hermes writes the client side):

```yaml
services:
  hermes-alice:
    # ...
    volumes:
      - ./profiles/alice:/data
      - ./run/sentient:/run/sentient
```

- [ ] Ensure the directory exists on the host:

```bash
mkdir -p deploy/docker/run/sentient
```

- [ ] Add `deploy/docker/run/` to `.gitignore` (the socket file is ephemeral):

```bash
grep -q "^deploy/docker/run/" .gitignore || echo "deploy/docker/run/" >> .gitignore
```

### Step 1.4.4d: Verify + commit

- [ ] Build + boot:

```bash
cd deploy/docker && docker compose up -d hermes-alice && cd ../..
```

- [ ] Manually test from inside the Hermes container:

```bash
docker exec hermes-alice sh -c 'echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}" | nc -U /run/sentient/mcp.sock'
```

Expected: JSON response listing the 4 tools.

- [ ] Tear down: `cd deploy/docker && docker compose down && cd ../..`
- [ ] Commit:

```bash
git add gateway/src/ deploy/docker/docker-compose.yml .gitignore
git commit -m "$(cat <<'EOF'
feat(gateway): wire MCP host server into gateway lifecycle

Starts /run/sentient/mcp.sock at gateway boot. Registers the four v1
tools (identify_user, pause_audio, resume_audio, set_channel). Docker
compose mounts the socket dir into hermes-alice so 'nc -U' can dial.
sessionForConnection is a stub in Phase 1.4 — returns null; Phase 1.7
wires per-connection session binding.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.4.5 — Update alice profile to expose gateway MCP

**Files:**
- Modify: `profiles/alice/config.yaml` (already has `mcp_servers.gateway` from Phase 1.1 template)
- Modify: `deploy/docker/hermes/Dockerfile.slim` (ensure `netcat-openbsd` is installed for `nc`)

### Step 1.4.5a: Confirm netcat is in the image

The slim Dockerfile from Phase 1.1 already includes `netcat-openbsd`. If yours doesn't:

- [ ] Open `deploy/docker/hermes/Dockerfile.slim` and add to the `apt-get install` line:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*
```

### Step 1.4.5b: Rebuild slim image

```bash
cd deploy/docker/hermes && docker build -f Dockerfile.slim -t sentient-hermes:slim . && cd ../..
```

### Step 1.4.5c: Smoke-test Hermes calling the gateway MCP

- [ ] Boot compose:

```bash
cd deploy/docker && docker compose up -d && cd ../..
```

- [ ] Send a test prompt to Hermes that should trigger the `identify_user` tool:

```bash
curl -N -X POST http://hermes-alice:8643/v1/responses \
  -H "Authorization: Bearer $(cat deploy/docker/secrets/hermes_api_key_alice)" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.5-flash",
    "input": "Please call the identify_user tool with name=\"alice\" and tell me what it returned.",
    "stream": true,
    "max_output_tokens": 128
  }'
```

(Adjust `hermes-alice` → `localhost:8643` if not using docker network aliases.)

Expected in the SSE trace: `function_call` item added with `name: "identify_user"`, then a `function_call_output` with `"rebound to alice"` or the "session binding deferred" stub message.

- [ ] If the tool isn't found, Hermes's debug log will show it. Check:

```bash
docker logs hermes-alice --tail 50
```

- [ ] Tear down:

```bash
cd deploy/docker && docker compose down && cd ../..
```

### Step 1.4.5d: Commit if Dockerfile changed

```bash
git add deploy/docker/hermes/Dockerfile.slim
git commit -m "$(cat <<'EOF'
chore(deploy): ensure netcat-openbsd in slim image for MCP stdio

Hermes profiles dial /run/sentient/mcp.sock via nc -U. Confirm
netcat-openbsd is installed.

Co-Authored-By: <your-model-id>
EOF
)"
```

(No commit needed if the Dockerfile already had netcat.)

---

## Task 1.4.6 — Quality gate

- [ ] Stop any running containers that might collide:

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

- [ ] Run full CI:

```bash
source scripts/env.sh && bun run ci
```

Expected: green.

---

## Done

Phase 1.4 complete when:

- [ ] MCP protocol + JSON-RPC parsing + pure `handleRpc` handler in `mcp-host/`.
- [ ] Unix-socket listener round-trips tools/list.
- [ ] Four tools registered: `identify_user`, `pause_audio`, `resume_audio`, `set_channel`.
- [ ] MCP listener started at gateway boot; socket mounted into Hermes containers.
- [ ] Manual smoke test: Hermes successfully calls `identify_user` via the gateway MCP.
- [ ] `bun run ci` green.

**Proceed to** `2026-04-21-hermes-phase1.5-ha-mcp.md`.
