import { getLog } from "../logging/logger.js";
import type { PolicyContext, PolicyDecision, PolicyEngine } from "../security/policy-engine.js";
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
  /** Same vocabulary as `PolicyContext["role"]`, and for the same reason —
   *  this value is handed straight to `policy.evaluate`. */
  role: PolicyContext["role"];
  sessionChannel: "voice" | "text";
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  get(name: string): ToolHandler | null;
}

export interface McpServerDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
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
      const decision: PolicyDecision = deps.policy.evaluate({
        tool: params.name,
        userId: ctx.userId,
        role: ctx.role,
        sessionChannel: ctx.sessionChannel,
        args,
      });
      if (decision.action === "deny") {
        log.debug("tools/call.denied", { tool: params.name, rule: decision.rule, reason: decision.reason });
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `denied: ${decision.reason ?? "policy restriction"}` }],
            isError: true,
          },
        };
      }
      // confirm: auto-approve for now (full UX in Phase 2)
      if (decision.action === "confirm") {
        log.debug("tools/call.confirmed-auto", { tool: params.name, rule: decision.rule });
      }
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
