import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getLog } from "../logging/logger.js";
import { parseRpcLine } from "./mcp-protocol.js";
import { handleRpc } from "./mcp-server.js";
import type { McpServerDeps } from "./mcp-server.js";

const log = getLog(["sentient", "mcp-host", "unix-listener"]);

export interface UnixSocketListener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createUnixSocketListener(socketPath: string, userId: string, deps: McpServerDeps): UnixSocketListener {
  let server: ReturnType<typeof Bun.listen<unknown>> | null = null;
  let connSeq = 0;

  const contextDeps: McpServerDeps = {
    registry: deps.registry,
    // Every connection on THIS socket belongs to `userId` by construction, so
    // the context is bound here rather than taken from the caller's `deps`.
    contextFor: () => ({ sessionId: null, userId, sessionChannel: "voice" }),
    ...(deps.refreshTools ? { refreshTools: deps.refreshTools } : {}),
  };

  /**
   * The reply the peer has not taken yet.
   *
   * WHY THIS EXISTS — measured live 2026-07-30. `socket.write` accepts only
   * what fits the socket's send buffer and RETURNS THE COUNT; the remainder is
   * the caller's problem. This server used to ignore that return value, which
   * was invisible while its whole surface was two hosted tools: a `tools/list`
   * reply was a few hundred bytes and always went in one write. Attaching the
   * proxied catalog tier makes that same reply ~31 KB, `write` took 8192 of it,
   * and the delegated agent got NOTHING — the truncated line has no trailing
   * newline, so the peer waits forever for a frame that will never complete.
   * (`initialize`, at ~150 bytes, answered normally on the same socket, which
   * is what isolated it from an "async handler can't write" theory.)
   *
   * So a reply is queued as BYTES, not text — a resumed write must not split a
   * multi-byte UTF-8 sequence — and the tail is pushed from `drain`.
   */
  interface ConnectionState {
    id: string;
    buffer: string;
    outbox: Uint8Array | null;
  }

  /** Push whatever the socket will take; keep the rest for the next `drain`. */
  function flushOutbox(socket: { write(data: Uint8Array): number }, data: ConnectionState): void {
    if (!data.outbox) return;
    const written = socket.write(data.outbox);
    if (written >= data.outbox.byteLength) {
      data.outbox = null;
      return;
    }
    // A non-positive return means the socket took nothing this round (closed or
    // still full); either way the remainder stays queued for `drain`.
    if (written > 0) data.outbox = data.outbox.subarray(written);
    log.debug("reply-backpressured", { connectionId: data.id, userId, written, remaining: data.outbox.byteLength });
  }

  function enqueueReply(socket: { write(data: Uint8Array): number }, data: ConnectionState, payload: string): void {
    const bytes = new TextEncoder().encode(payload);
    if (!data.outbox) {
      data.outbox = bytes;
    } else {
      const merged = new Uint8Array(data.outbox.byteLength + bytes.byteLength);
      merged.set(data.outbox, 0);
      merged.set(bytes, data.outbox.byteLength);
      data.outbox = merged;
    }
    flushOutbox(socket, data);
  }

  function openListener(): ReturnType<typeof Bun.listen<ConnectionState>> {
    return Bun.listen<ConnectionState>({
      unix: socketPath,
      socket: {
        open(socket) {
          const id = `conn-${++connSeq}`;
          socket.data = { id, buffer: "", outbox: null };
          log.debug("open", { connectionId: id, userId });
        },
        async data(socket, chunk) {
          const data = socket.data;
          if (!data) return;
          data.buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
          let idx = data.buffer.indexOf("\n");
          while (idx !== -1) {
            const line = data.buffer.slice(0, idx);
            data.buffer = data.buffer.slice(idx + 1);
            const res = await respondTo(line, data.id);
            if (res !== null) enqueueReply(socket, data, `${res}\n`);
            idx = data.buffer.indexOf("\n");
          }
        },
        drain(socket) {
          const data = socket.data;
          if (data) flushOutbox(socket, data);
        },
        close(socket) {
          log.debug("close", { connectionId: socket.data?.id, userId });
        },
        error(_socket, err) {
          log.debug("error", { err: err.message, userId });
        },
      },
    });
  }

  /** One newline-delimited JSON-RPC line in, one serialized reply (or null for
   *  a blank line / notification) out. Split out of the socket handler so that
   *  handler stays inside the 3-level nesting limit. */
  async function respondTo(line: string, connectionId: string): Promise<string | null> {
    if (line.trim().length === 0) return null;
    const parsed = parseRpcLine(line);
    if (!parsed.ok) return JSON.stringify(parsed.error);
    const res = await handleRpc(parsed.req, connectionId, contextDeps);
    return res ? JSON.stringify(res) : null;
  }

  return {
    async start() {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(socketPath);
      } catch {
        /* ignore — socket may not exist yet */
      }

      // `Bun.listen({unix})` THROWS ENOENT when the socket's parent directory
      // does not exist, and this whole start() used to let that throw escape
      // out of `mcpHost.start()` at boot. The native gateway has no docker
      // bind-mount creating the configured dir, so create it before listening.
      try {
        await mkdir(dirname(socketPath), { recursive: true });
      } catch (err) {
        log.warn("socket-dir-create-failed", {
          socketPath,
          userId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      // Allow the Hermes peer (non-root) to connect to the socket the gateway
      // creates. The directory is shared only between gateway + hermes, so
      // 0666 is safe.
      const { chmodSync } = await import("node:fs");

      // FAIL SOFT, NEVER BOOT-FATAL. Two very different failures used to come
      // out of the one unguarded `Bun.listen` below. Under a plain `bun` run
      // (and the compiled binary) the uncaught throw KILLS the gateway at
      // startup. Under `bun --hot` the process survives but its event loop is
      // left unable to fire timers, so the next `setTimeout`-based await in
      // the boot reconcile — the addon health poll's inter-attempt sleep —
      // never resolves: `apply.complete` never fires, local-tts is never
      // launched, and the post-boot health watchdog is never armed. A per-user
      // tool socket is a degradable dependency (error-handling rule: an
      // adapter's start() resolves without throwing on a missing dependency).
      try {
        server = openListener();
      } catch (err) {
        log.warn("listener-start-failed", {
          socketPath,
          userId,
          reason: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      try {
        chmodSync(socketPath, 0o666);
      } catch (err) {
        log.warn("chmod-failed", {
          socketPath,
          userId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      log.info("listener-started", { socketPath, userId });
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
      log.info("listener-stopped", { socketPath, userId });
    },
  };
}
