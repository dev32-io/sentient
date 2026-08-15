import type { ProductToolGroup } from "@sentient/config";
import type { NativeToolRunner } from "../tools/tool-broker.js";
import { homeProductToolProvider } from "./product-tools/home-provider.js";
import { musicProductToolProvider } from "./product-tools/music-provider.js";
import { webProductToolProvider } from "./product-tools/web-provider.js";

export type FoundationProductGroup = "web" | "home" | "music";

/** A group-owned contribution slot. Future providers implement only their
 * factory and receive only their own configuration object; this registry and
 * other groups remain untouched. */
export interface ProductToolProvider<G extends FoundationProductGroup = FoundationProductGroup> {
  readonly group: G;
  create(config: Readonly<Record<string, unknown>>): readonly NativeToolRunner[];
}

export interface ProductToolProviderSlots {
  readonly web: ProductToolProvider<"web">;
  readonly home: ProductToolProvider<"home">;
  readonly music: ProductToolProvider<"music">;
}

export interface ProductToolProviderConfig {
  readonly web?: Readonly<Record<string, unknown>>;
  readonly home?: Readonly<Record<string, unknown>>;
  readonly music?: Readonly<Record<string, unknown>>;
}

/** Stable bootstrap-owned slots. Each value lives in its independently-owned
 * module, so a foundation lands by editing that module only. */
export const EMPTY_PRODUCT_TOOL_PROVIDERS: ProductToolProviderSlots = {
  web: webProductToolProvider,
  home: homeProductToolProvider,
  music: musicProductToolProvider,
};

/** Produces one authoritative native runner map and rejects cross-provider
 * collisions. Metadata is checked rather than reconstructed from tool names. */
export function composeProductToolProviders(
  slots: ProductToolProviderSlots = EMPTY_PRODUCT_TOOL_PROVIDERS,
  config: ProductToolProviderConfig = {},
): Map<string, NativeToolRunner> {
  const out = new Map<string, NativeToolRunner>();
  for (const provider of [slots.web, slots.home, slots.music] as const) {
    const providerConfig = config[provider.group] ?? {};
    for (const runner of provider.create(providerConfig)) {
      if (runner.definition.productGroup !== (provider.group satisfies ProductToolGroup)) {
        throw new Error(
          `product tool provider ${provider.group} contributed ${runner.definition.name} for group ${runner.definition.productGroup ?? "unset"}`,
        );
      }
      if (out.has(runner.definition.name)) {
        throw new Error(`duplicate product tool contribution: ${runner.definition.name}`);
      }
      out.set(runner.definition.name, runner);
    }
  }
  return out;
}
