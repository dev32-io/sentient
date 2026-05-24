import { createLogger } from "./logger.ts";

/** Tagged logger for the web SDK internals. */
export const sdkLog = createLogger(["sentient", "web-sdk", "sdk"]);
