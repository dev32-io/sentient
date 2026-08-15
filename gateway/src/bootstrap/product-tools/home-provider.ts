import type { ProductToolProvider } from "../product-tool-providers.js";

/** Home-owned configuration seam. */
export interface HomeProductToolConfig extends Readonly<Record<string, unknown>> {}

export const homeProductToolProvider: ProductToolProvider<"home"> = {
  group: "home",
  create: (_config) => [],
};
