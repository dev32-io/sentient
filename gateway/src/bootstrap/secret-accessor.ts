import type { InternalSecretsStore } from "../admin/internal-secrets-store.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import type { SecretAccessor } from "../system-orchestrator/template-loader.js";

/** Known internal.* keys and their resolvers. */
const INTERNAL_RESOLVERS: Record<string, (store: InternalSecretsStore) => string> = {
  searxng_secret: (store) => store.getSearxngSecretSync(),
};

export function makeSecretAccessor(store: SecretsStore | null, internalStore: InternalSecretsStore): SecretAccessor {
  return {
    resolve(path: string): string | null {
      // Path syntax: dotted lookup, optionally suffixed with `:host` to
      // extract hostname from a URL value. Used by service templates that
      // need extra_hosts mapping derived from a user-entered URL.
      // Example: `music_assistant.url:host` → "mass.local" if user
      // entered `http://mass.local:8095`.
      const [rawPath, derive] = path.split(":");
      const lookupPath = rawPath ?? path;

      // internal.* namespace — dispatches to gateway-managed secrets.
      if (lookupPath.startsWith("internal.")) {
        const key = lookupPath.slice("internal.".length);
        const resolver = INTERNAL_RESOLVERS[key];
        return resolver ? resolver(internalStore) : null;
      }

      if (!store) return null;
      const parts = lookupPath.split(".");
      let cur: unknown = store.loadSync();
      for (const p of parts) {
        if (cur === null || typeof cur !== "object") return null;
        cur = (cur as Record<string, unknown>)[p];
      }
      if (typeof cur !== "string") return null;
      if (derive === "host") return extractHost(cur);
      return cur;
    },
  };
}

/** Extracts hostname from a URL string. Handles `host:port`, `scheme://host`,
 *  `scheme://host:port`. Returns null if the input doesn't yield a hostname. */
export function extractHost(value: string): string | null {
  if (!value) return null;
  // Try absolute URL parse first (handles scheme + port + path).
  try {
    const u = new URL(value);
    return u.hostname || null;
  } catch {
    // No scheme — strip path/port from `host:port/path` shape.
    const noPath = value.split("/")[0] ?? value;
    const noPort = noPath.split(":")[0] ?? noPath;
    return noPort.length > 0 ? noPort : null;
  }
}
