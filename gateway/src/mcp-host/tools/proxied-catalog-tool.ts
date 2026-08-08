// One PROXIED catalog tool, exposed on the gateway's per-user MCP socket.
//
// THE POINT OF THE PROXY IS THE BROKER. A delegated agent that dialled
// `mcp_catalog`'s HTTP servers itself would run entirely outside the gateway's
// PDP: no rule evaluation, no argument-value check, no deny. This handler
// exists so those calls become ordinary `ToolBroker.dispatch` calls — the same
// L3 choke point the gateway's own ReAct loop goes through, with the same
// per-call decision and the same log line. A proxy that dialled the upstream
// directly would be WORSE than no proxy, because it looks mediated and is not.
//
// NAMING SCHEME — upstream name, verbatim. Not a prefix, and deliberately so:
// the bare name is what `config.yaml#mcp_catalog` tiers and what the broker's
// PDP resolves a permission for, so renaming it here would silently detach
// every proxied tool from the catalog entry that tiers it (a name in no table
// resolves `off`, which fails closed — a whole tier that quietly stops
// working). Ambiguity is
// already resolved one layer up: hermes namespaces everything it reaches
// through this socket as `mcp__gateway__<name>`. Collisions inside the surface
// are resolved by DROPPING the duplicate, in `proxied-tool-surface.ts`.

import { getLog } from "../../logging/logger.js";
import type { McpToolRef } from "../../tools/mcp-client.js";
import type { ToolBroker } from "../../tools/tool-broker.js";
import type { ToolCallResult, ToolDefinition } from "../mcp-protocol.js";
import type { ToolContext, ToolHandler } from "../mcp-server.js";

const log = getLog(["sentient", "mcp-host", "proxied-tool"]);

/**
 * `turnId` on a proxied invocation. The broker reads it only to key
 * `delegation.progress` frames for BACKGROUND tools, and nothing background can
 * reach this surface (see `proxied-tool-surface.ts`), so it is a log-correlation
 * label rather than a real turn.
 */
const DELEGATED_TURN_ID = "delegated";

const NO_USER_MESSAGE = "no user is bound to this MCP connection";
const NO_BROKER_MESSAGE = "the gateway cannot mediate this call right now";
const BACKGROUND_MESSAGE = "this tool dispatched as a background task, which a delegated caller cannot observe";

export interface ProxiedCatalogToolDeps {
  /** Resolves the delegated `ToolBroker` for the user on the other end of the
   *  socket. `null` means no broker could be built (no `orchestrator:` block, a
   *  malformed user id, or no user record to take a role from) — the call then
   *  fails closed rather than running unmediated. Async because the broker's
   *  authority is the DELEGATOR'S OWN ROLE, read from the user store. */
  brokerFor(userId: string): Promise<ToolBroker | null>;
}

/** Coerce an upstream JSON-Schema blob into the shape `tools/list` advertises.
 *  `properties` passes through wholesale, so nested schemas survive intact. */
function toInputSchema(schema: Record<string, unknown>): ToolDefinition["inputSchema"] {
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : [];
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(typeof schema.additionalProperties === "boolean" ? { additionalProperties: schema.additionalProperties } : {}),
  };
}

function errorResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function createProxiedCatalogTool(ref: McpToolRef, deps: ProxiedCatalogToolDeps): ToolHandler {
  const def: ToolDefinition = {
    name: ref.name,
    description: ref.description,
    inputSchema: toInputSchema(ref.inputSchema),
  };

  async function run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolCallResult> {
    if (!ctx.userId) {
      log.warn("proxied-tool.no-user", { tool: ref.name, server: ref.serverName, reason: NO_USER_MESSAGE });
      return errorResult(NO_USER_MESSAGE);
    }
    const broker = await deps.brokerFor(ctx.userId);
    if (!broker) {
      log.warn("proxied-tool.no-broker", {
        tool: ref.name,
        server: ref.serverName,
        userId: ctx.userId,
        reason: "no delegated ToolBroker for this user; failing closed rather than dialing the upstream directly",
      });
      return errorResult(NO_BROKER_MESSAGE);
    }

    const toolCallId = crypto.randomUUID();
    const startedAt = Date.now();
    log.debug("proxied-tool.dispatch", {
      tool: ref.name,
      server: ref.serverName,
      userId: ctx.userId,
      toolCallId,
      argKeys: Object.keys(args),
    });

    // The per-server deadline in `mcp_catalog` bounds this call inside
    // `mcp-client.callTool`, so the signal is a never-aborting placeholder
    // rather than a second, competing timeout. A delegated run has no turn to
    // barge in on and no Stop button attached to it.
    const outcome = await broker.dispatch({
      toolCallId,
      name: ref.name,
      args,
      signal: new AbortController().signal,
      turnId: DELEGATED_TURN_ID,
    });

    if ("taskId" in outcome) {
      log.warn("proxied-tool.background-dispatch", {
        tool: ref.name,
        userId: ctx.userId,
        toolCallId,
        reason: "a background tool reached the proxied surface; it has no completion path on this socket",
      });
      return errorResult(BACKGROUND_MESSAGE);
    }

    log.info("proxied-tool.done", {
      tool: ref.name,
      server: ref.serverName,
      userId: ctx.userId,
      toolCallId,
      isError: outcome.isError,
      contentLength: outcome.content.length,
      elapsedMs: Date.now() - startedAt,
    });
    return { content: [{ type: "text", text: outcome.content }], isError: outcome.isError };
  }

  return { def, run };
}
