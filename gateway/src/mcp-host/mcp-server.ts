import { getLog } from "../logging/logger.js";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  type ToolCallResult,
  type ToolDefinition,
} from "./mcp-protocol.js";

const log = getLog(["sentient", "mcp-host", "server"]);

export interface ToolHandler {
  def: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolCallResult>;
}

export interface ToolContext {
  sessionId: string | null;
  userId: string | null;
  /** Read by the tools that are only MEANINGFUL on one channel — today just
   *  `identify-user.ts`, which owns that constraint itself because no
   *  permission table can express "only during a voice session" (it is
   *  per-session, not per-user or per-role). Carries no authorization weight:
   *  who may hold a tool on this socket is decided by `delegated-tool-tier.ts`
   *  before the registry is built. */
  sessionChannel: "voice" | "text";
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  get(name: string): ToolHandler | null;
}

/**
 * WHERE THE AUTHORIZATION IS, since it is deliberately not in this file.
 *
 * A `tools/call` here has already passed the one gate that applies to it: the
 * registry only ever contains tools `external-tools/delegated-tool-tier.ts`
 * admitted, and it admits only the `read` tier — the tier every role reaches
 * and whose default permission is prompt-free. That is the boundary for the
 * gateway's own HOSTED tools, which run in-process with no human to ask.
 * PROXIED catalog tools are a different path: `tools/proxied-catalog-tool.ts`
 * dispatches them through the DELEGATOR's own `ToolBroker`, whose role gate and
 * permission table mediate every one.
 *
 * There used to be a second, name-keyed policy evaluation here, over
 * `gateway/mcp-policy.yaml`. Its `confirm` verdict auto-approved — there is
 * nobody on a delegated socket to prompt — so it could only ever deny, and
 * everything it denied the tier filter already withholds. Two classifications
 * of the same tools that must agree is a thing that eventually does not.
 */
export interface McpServerDeps {
  registry: ToolRegistry;
  contextFor(connectionId: string): ToolContext;
  /**
   * Re-derive any dynamic part of the registry before answering `tools/list`.
   *
   * The gateway's own hosted tools are fixed at construction, but the PROXIED
   * catalog tier is not: an addon that came up after the gateway did would
   * otherwise stay invisible until a restart, and one that went away would
   * stay advertised. Awaited on the LIST path only — a `tools/call` names a
   * tool the caller has already listed, and re-dialing the whole catalog
   * before every call would put the catalog's connect timeouts on the inner
   * loop of a delegated run.
   *
   * MUST NOT throw and MUST be bounded by its own implementation; a rejection
   * here is caught and the previous surface answers.
   */
  refreshTools?: () => Promise<void>;
}

/** Refresh the dynamic tool tier without ever failing the listing: an
 *  unreachable catalog leaves the previous surface in place, which degrades the
 *  delegated agent to fewer tools rather than closing its connection. */
async function refreshSafely(deps: McpServerDeps): Promise<void> {
  if (!deps.refreshTools) return;
  try {
    await deps.refreshTools();
  } catch (err: unknown) {
    log.warn("tools/list.refresh-failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Handle one JSON-RPC request. The only I/O it may do is `refreshTools` on the
 * listing path; the caller owns the transport.
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
        capabilities: { tools: {} },
        serverInfo: { name: "sentient-gateway-mcp", version: "1.0.0" },
      },
    };
  }

  if (req.method === "tools/list") {
    await refreshSafely(deps);
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: deps.registry.list() },
    };
  }

  if (req.method === "tools/call") {
    const params = (req.params ?? {}) as {
      name?: unknown;
      arguments?: unknown;
    };
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
        error: {
          code: RPC_METHOD_NOT_FOUND,
          message: `unknown tool: ${params.name}`,
        },
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
    } catch (err: unknown) {
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
    error: {
      code: RPC_METHOD_NOT_FOUND,
      message: `unknown method: ${req.method}`,
    },
  };
}
