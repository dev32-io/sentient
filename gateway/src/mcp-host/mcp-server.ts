import { getLog } from "../logging/logger.js";
import type { PolicyDecision, PolicyEngine } from "../security/policy-engine.js";
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
  role: "adult" | "child" | "guest" | "user";
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
        capabilities: { tools: {} },
        serverInfo: { name: "sentient-gateway-mcp", version: "1.0.0" },
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
