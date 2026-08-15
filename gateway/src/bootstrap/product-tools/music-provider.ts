import type { ProductToolProvider } from "../product-tool-providers.js";

/** Music-owned configuration seam. */
export interface MusicProductToolConfig extends Readonly<Record<string, unknown>> {}

export const musicProductToolProvider: ProductToolProvider<"music"> = {
  group: "music",
  create: (_config) => [],
};
