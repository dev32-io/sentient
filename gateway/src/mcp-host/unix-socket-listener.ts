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
    policy: deps.policy,
    contextFor: () => ({ sessionId: null, userId, role: "user", sessionChannel: "voice" }),
  };

  return {
    async start() {
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(socketPath);
      } catch {
        /* ignore — socket may not exist yet */
      }

      // Allow the Hermes container (UID 10000, non-root) to connect to the
      // socket the gateway (root) creates. The bind-mounted directory is
      // only shared between gateway + its hermes peer, so 0666 is safe.
      const { chmodSync } = await import("node:fs");

      server = Bun.listen<{ id: string; buffer: string }>({
        unix: socketPath,
        socket: {
          open(socket) {
            const id = `conn-${++connSeq}`;
            socket.data = { id, buffer: "" };
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
              if (line.trim().length === 0) {
                idx = data.buffer.indexOf("\n");
                continue;
              }
              const parsed = parseRpcLine(line);
              if (!parsed.ok) {
                socket.write(`${JSON.stringify(parsed.error)}\n`);
                idx = data.buffer.indexOf("\n");
                continue;
              }
              const res = await handleRpc(parsed.req, data.id, contextDeps);
              if (res) socket.write(`${JSON.stringify(res)}\n`);
              idx = data.buffer.indexOf("\n");
            }
          },
          close(socket) {
            log.debug("close", { connectionId: socket.data?.id, userId });
          },
          error(_socket, err) {
            log.debug("error", { err: err.message, userId });
          },
        },
      });
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
