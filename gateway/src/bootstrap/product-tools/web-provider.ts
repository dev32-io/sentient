import type { ProductToolProvider } from "../product-tool-providers.js";

/** Web-owned configuration seam. The native web foundation extends this type
 * and factory in this module only. */
export interface WebProductToolConfig extends Readonly<Record<string, unknown>> {}

export const webProductToolProvider: ProductToolProvider<"web"> = {
  group: "web",
  create: (_config) => [],
};
