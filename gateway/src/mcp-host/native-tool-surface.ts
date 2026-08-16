import { selectDelegatedTools } from "../external-tools/delegated-tool-tier.js";
import type { ToolBroker } from "../tools/tool-broker.js";
import type { ToolDefinition } from "./mcp-protocol.js";
import type { ToolHandler } from "./mcp-server.js";
import { createProxiedNativeTool } from "./tools/proxied-catalog-tool.js";

const DELEGATED_PRODUCT_GROUPS = new Set(["web", "home", "music"]);

/** Per-user projection of authoritative native product metadata. The broker's
 * definitions apply the role ceiling and current product resolution; this
 * final selector admits only explicitly allowed reads from the three
 * first-class product groups. Ask/deny/off are unanswerable in delegation and
 * therefore absent rather than merely failing after advertisement. */
export interface NativeToolSurface {
  refresh(): Promise<void>;
  definitions(): ToolDefinition[];
  handler(name: string): ToolHandler | null;
}

export function createNativeToolSurface(
  userId: string,
  brokerFor: (userId: string) => Promise<ToolBroker | null>,
  hostedNames: ReadonlySet<string>,
): NativeToolSurface {
  let handlers: ToolHandler[] = [];
  let byName = new Map<string, ToolHandler>();

  return {
    async refresh() {
      const broker = await brokerFor(userId);
      if (!broker) {
        handlers = [];
        byName = new Map();
        return;
      }
      await broker.ready();
      const eligible = selectDelegatedTools(
        broker
          .definitions({ permissions: ["allow"] })
          .filter(
            (definition) =>
              definition.category === "foreground" &&
              definition.productGroup !== undefined &&
              DELEGATED_PRODUCT_GROUPS.has(definition.productGroup) &&
              !hostedNames.has(definition.name),
          ),
      );
      handlers = eligible.map((definition) => createProxiedNativeTool(definition, { brokerFor }));
      byName = new Map(handlers.map((handler) => [handler.def.name, handler]));
    },
    definitions: () => handlers.map((handler) => handler.def),
    handler: (name) => byName.get(name) ?? null,
  };
}
