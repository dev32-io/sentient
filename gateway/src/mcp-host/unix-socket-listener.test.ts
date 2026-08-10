import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolRegistry } from "./mcp-server.js";
import { createUnixSocketListener } from "./unix-socket-listener.js";

const SOCKET_PATH = join(tmpdir(), `sentient-mcp-test-${process.pid}.sock`);

const registry: ToolRegistry = {
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
};

const listener = createUnixSocketListener(SOCKET_PATH, "alice", {
  registry,
  contextFor: () => ({ sessionId: null, userId: "alice", sessionChannel: "voice" }),
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
    const parsed = JSON.parse(response.trim()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(parsed.result.tools[0]?.name).toBe("ping");
  });

  // BOOT-FATALITY INVARIANT. `Bun.listen({unix})` throws when the socket's
  // parent path is unusable, and that throw used to escape `mcpHost.start()`
  // at gateway boot: under a plain `bun`/compiled-binary run it KILLED the
  // gateway; under `bun --hot` the process survived but its event loop could
  // no longer fire timers, so the boot reconcile's health-poll sleep never
  // resolved — `apply.complete` never fired, local-tts was never launched, and
  // the post-boot health watchdog was never armed. Reproduced live 4/4 boots.
  it("resolves instead of throwing when the socket path cannot be listened on", async () => {
    // /dev/null is a character device, so it can be neither mkdir'd into nor
    // used as a socket's parent directory.
    const unusable = "/dev/null/nope/mcp-carol.sock";
    const carol = createUnixSocketListener(unusable, "carol", {
      registry,
      contextFor: () => ({ sessionId: null, userId: "carol", sessionChannel: "voice" }),
    });

    await expect(carol.start()).resolves.toBeUndefined();
    await expect(carol.stop()).resolves.toBeUndefined();
  });

  // WIRE CONTRACT, found live 2026-07-30 while attaching the proxied catalog
  // tier. `socket.write` accepts only what fits the send buffer and returns the
  // count; this listener ignored that, so a reply larger than one write was
  // TRUNCATED — and a truncated JSON-RPC line has no trailing newline, so the
  // peer waits forever rather than erroring. Measured: a 31,604-byte
  // `tools/list` of which `write` took 8,192, and a delegated hermes that saw
  // no tools at all. Invisible until now only because the hosted surface was
  // two tools and always fitted.
  it("delivers a reply larger than one socket write, whole", async () => {
    const bigRegistry: ToolRegistry = {
      list() {
        return Array.from({ length: 200 }, (_, i) => ({
          name: `tool_${i}`,
          description: "x".repeat(500),
          inputSchema: { type: "object" as const, properties: {} },
        }));
      },
      get: () => null,
    };
    const bigSocket = join(tmpdir(), `sentient-mcp-big-${process.pid}.sock`);
    const bigListener = createUnixSocketListener(bigSocket, "dave", {
      registry: bigRegistry,
      contextFor: () => ({ sessionId: null, userId: "dave", sessionChannel: "voice" }),
      // Real I/O before the reply, exactly like the proxied-tier refresh: it
      // pushes the write past the socket callback's cork and into the
      // backpressure path this test exists for.
      refreshTools: () => new Promise((resolve) => setTimeout(resolve, 5)),
    });

    try {
      await bigListener.start();
      const response: string = await new Promise((resolve, reject) => {
        const socket = connect(bigSocket);
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
      expect(parsed.result.tools).toHaveLength(200);
      expect(parsed.result.tools[199]?.name).toBe("tool_199");
    } finally {
      await bigListener.stop();
    }
  }, 15000);

  it("provides userId from per-socket binding in tool context", async () => {
    const toolCalls: Array<{ userId: string | null }> = [];
    const contextRegistry: ToolRegistry = {
      list() {
        return [
          {
            name: "whoami",
            description: "returns user id",
            inputSchema: { type: "object" as const, properties: {} },
          },
        ];
      },
      get(name) {
        if (name !== "whoami") return null;
        return {
          def: {
            name: "whoami",
            description: "returns user id",
            inputSchema: { type: "object" as const, properties: {} },
          },
          async run(_args, ctx) {
            toolCalls.push({ userId: ctx.userId });
            return { content: [{ type: "text" as const, text: ctx.userId ?? "unknown" }] };
          },
        };
      },
    };

    const bobSocket = join(tmpdir(), `sentient-mcp-bob-${process.pid}.sock`);
    const bobListener = createUnixSocketListener(bobSocket, "bob", {
      registry: contextRegistry,
      contextFor: () => ({ sessionId: null, userId: "bob", sessionChannel: "voice" }),
    });

    try {
      await bobListener.start();
      const response: string = await new Promise((resolve, reject) => {
        const socket = connect(bobSocket);
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
          socket.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami"}}\n');
        });
      });
      const parsed = JSON.parse(response.trim()) as {
        result: { content: Array<{ text: string }> };
      };
      expect(parsed.result.content[0]?.text).toBe("bob");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.userId).toBe("bob");
    } finally {
      await bobListener.stop();
    }
  });
});
