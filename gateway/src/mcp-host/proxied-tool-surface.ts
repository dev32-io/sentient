// The PROXIED tier of the gateway's per-user MCP socket.
//
// The owner's framing, verbatim: "gateway's proxy is essentially just providing
// additional 'sentient built-in mcps' on top of user's own setup to give it
// more flexibility and capability … we are essentially providing a secondary
// tier of mcp via proxy at this point".
//
// So this surface is ADDITIVE capability, and everything in it passes the
// gateway's PDP on the way through (`tools/proxied-catalog-tool.ts`). It exists
// because `hermes mcp add` grants a server's WHOLE upstream surface — registering
// `home_assistant` on a delegated profile would hand it ha-mcp's ~84 tools,
// including the write ones. Proxying instead means the gateway advertises
// exactly the `allow` tier and mediates every call.
//
// REFRESHED AT THE MOMENT OF USE, symmetric with the dispatch-time provisioning
// in `external-tools/`. `tools/list` on a delegated connection re-derives this
// set, so a catalog server that came up after the gateway did is picked up
// without a restart, and one that went away stops being advertised. There is no
// cached-forever surface to drift. The cost is one `listTools()` round trip per
// delegated session start, bounded by each catalog entry's own `connect_timeout`.
//
// ONE MCP CLIENT, NOT TWO. Discovery and dispatch both run through the shared
// `tools/mcp-client.ts` — discovery via `listCatalogTools`, dispatch via the
// broker. A second dialer to the same servers would double the connection count
// and, worse, be a second place the catalog's `tools.include` filter could drift.

import { PROXIED_TOOL_CONTEXT, selectDelegatedAllowTier } from "../external-tools/delegated-tool-tier.js";
import { getLog } from "../logging/logger.js";
import type { PolicyEngine } from "../security/policy-engine.js";
import type { McpToolRef } from "../tools/mcp-client.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition } from "./mcp-protocol.js";
import type { ToolHandler } from "./mcp-server.js";
import { createProxiedCatalogTool } from "./tools/proxied-catalog-tool.js";

const log = getLog(["sentient", "mcp-host", "proxied-surface"]);

export interface ProxiedToolSurface {
  /** Re-dial the catalog, re-derive the allow tier, swap the handler set.
   *  NEVER throws and NEVER leaves the surface half-built: a listing failure
   *  empties it, which degrades the delegated agent to the gateway's own hosted
   *  tools rather than breaking the connection. */
  refresh(): Promise<void>;
  /** What `tools/list` advertises from this tier, in catalog order. */
  definitions(): ToolDefinition[];
  handler(name: string): ToolHandler | null;
}

export interface ProxiedToolSurfaceDeps {
  /** The shared `McpClient.listTools()` — already narrowed by each catalog
   *  entry's `tools.include`. */
  listCatalogTools(): Promise<McpToolRef[]>;
  policy: PolicyEngine;
  brokerFor(userId: string): Promise<ToolBroker | null>;
  /** EVERY name the gateway implements in-process — including the ones the
   *  tier withholds. A catalog tool with a matching name is DROPPED, never
   *  shadowed: two handlers under one name would make the PDP decision and the
   *  executed code disagree, and a withheld hosted tool must not be quietly
   *  re-granted by an upstream server that happens to use the same name. */
  hostedNames: ReadonlySet<string>;
}

export function createProxiedToolSurface(deps: ProxiedToolSurfaceDeps): ProxiedToolSurface {
  let handlers: ToolHandler[] = [];
  let byName = new Map<string, ToolHandler>();

  async function listSafely(): Promise<McpToolRef[] | null> {
    try {
      return await deps.listCatalogTools();
    } catch (err: unknown) {
      log.warn("proxied-surface.list-failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  function build(refs: McpToolRef[]): ToolHandler[] {
    const allowed = new Set(
      selectDelegatedAllowTier(
        deps.policy,
        refs.map((r) => r.name),
        PROXIED_TOOL_CONTEXT,
      ),
    );
    const built: ToolHandler[] = [];
    const dropped: Array<{ tool: string; server: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      if (!allowed.has(ref.name)) continue; // already logged by the tier selector
      const collision = deps.hostedNames.has(ref.name)
        ? "collides with a gateway-hosted tool"
        : seen.has(ref.name)
          ? "a catalog server already advertises this name"
          : null;
      if (collision) {
        dropped.push({ tool: ref.name, server: ref.serverName, reason: collision });
        continue;
      }
      seen.add(ref.name);
      built.push(createProxiedCatalogTool(ref, { brokerFor: deps.brokerFor }));
    }
    if (dropped.length > 0) log.warn("proxied-surface.name-collision", { dropped });
    return built;
  }

  return {
    async refresh() {
      const refs = await listSafely();
      const next = refs === null ? [] : build(refs);
      handlers = next;
      byName = new Map(next.map((h) => [h.def.name, h]));
      log.info("proxied-surface.refreshed", {
        advertised: next.map((h) => h.def.name),
        catalogToolCount: refs?.length ?? 0,
      });
    },
    definitions() {
      return handlers.map((h) => h.def);
    },
    handler(name: string) {
      return byName.get(name) ?? null;
    },
  };
}
