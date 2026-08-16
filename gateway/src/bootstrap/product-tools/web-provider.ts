import type { Capability } from "../../access/capability.js";
import type { ProviderClient } from "../../provider/provider-client.js";
import { createWebTools } from "../../tools/web/web-tools.js";
import type { WebToolsConfig } from "../../tools/web/web-tools.js";
import type { ProductToolProvider } from "../product-tool-providers.js";

/** Session-scoped internal configuration assembled by the bootstrap seam. It is
 * never populated from model arguments: the capability is minted from the
 * authenticated principal and the limits come from operator configuration. */
export interface WebProductToolConfig extends Readonly<Record<string, unknown>> {
  capability: Capability;
  tools: WebToolsConfig;
  provider?: ProviderClient;
  summaryPrompt?: string;
  screen?: (text: string) => string;
}

function isConfig(value: Readonly<Record<string, unknown>>): value is WebProductToolConfig {
  return "capability" in value && "tools" in value;
}

export const webProductToolProvider: ProductToolProvider<"web"> = {
  group: "web",
  create(config) {
    if (!isConfig(config)) return [];
    return createWebTools({
      capability: config.capability,
      config: config.tools,
      ...(config.provider ? { provider: config.provider } : {}),
      ...(config.summaryPrompt ? { summaryPrompt: config.summaryPrompt } : {}),
      ...(config.screen ? { screen: config.screen } : {}),
    });
  },
};
