// Resolves the runtime asset root — the directory holding templates/,
// system_prompts/, persona.md, mcp-policy.yaml, config/delegation/ and webui/.
//
// Two shapes must both work:
//   repo checkout   — assets sit at <repo>/gateway/, reachable from import.meta.dir
//   compiled binary — import.meta.dir is the embedded /$bunfs/root, which contains
//                     NO assets, so GATEWAY_RUNTIME_DIR must point at the unpacked
//                     share/ dir beside the executable.
//
// A wrong root previously surfaced as `ENOENT ... '/templates/profile/...'` at
// boot, which names neither the cause nor the fix. This module fails loudly
// instead, and is the single place any asset path is computed — a new
// module-scope `join(import.meta.dir, "..", "..")` reintroduces the whole class.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "config", "asset-root"]);

/** Directory that must exist under the root for it to be a plausible asset
 *  root. `templates/` ships in every deployment shape and is read at module
 *  init by several loaders, so its absence is always fatal. */
const SENTINEL = "templates";

/** Remediation half of the fail-loud error — names the fix, not just the symptom. */
const REMEDIATION = [
  "Set GATEWAY_RUNTIME_DIR to the directory containing templates/, system_prompts/,",
  "persona.md and webui/. In a compiled binary this MUST be set — import.meta.dir",
  "points at the embedded bundle, which carries no assets.",
].join(" ");

let cached: string | null = null;

/** Absolute path to the directory holding the gateway's baked-in runtime
 *  assets. Memoised: the root cannot change within a process lifetime. */
export function resolveAssetRoot(): string {
  if (cached !== null) return cached;
  const fromEnv = process.env.GATEWAY_RUNTIME_DIR;
  const hasEnv = fromEnv !== undefined && fromEnv.length > 0;
  cached = hasEnv ? fromEnv : join(import.meta.dir, "..", "..");
  log.debug("resolved", { root: cached, reason: hasEnv ? "GATEWAY_RUNTIME_DIR" : "import.meta.dir" });
  return cached;
}

/** Joins `segments` onto the asset root, throwing an actionable error if the
 *  root is not a real asset root. Never returns a path built on a bogus root. */
export function assetPath(...segments: string[]): string {
  const root = resolveAssetRoot();
  if (!existsSync(join(root, SENTINEL))) {
    throw new Error(`asset root has no ${SENTINEL}/ directory: ${root}. ${REMEDIATION}`);
  }
  return join(root, ...segments);
}

/** Test-only: clears the memoised root. */
export function resetAssetRootForTest(): void {
  cached = null;
}

/** Where the BUILT web bundle lives, or undefined when nothing has been built.
 *
 *  Two shapes, and they differ by one path segment — which is exactly why the
 *  naive `assetPath("webui")` is wrong:
 *
 *    installed release — share/webui/index.html      (build-gateway.sh copies
 *                                                     webui/dist -> share/webui)
 *    repo checkout     — gateway/webui/dist/index.html  (webui/ is SOURCE here)
 *
 *  Probing for index.html rather than branching on "am I compiled" keeps the two
 *  shapes from needing a flag that could be wrong. `WEB_DIST_DIR` stays as an
 *  override for operators pointing at a bundle outside either layout.
 *
 *  Returns undefined rather than throwing: a gateway with no UI still serves the
 *  API, and the launcher builds the bundle before start (scripts/stack.sh). */
export function resolveWebDistDir(): string | undefined {
  const override = process.env.WEB_DIST_DIR;
  if (override !== undefined && override.length > 0) {
    log.debug("web-dist.resolved", { dir: override, reason: "WEB_DIST_DIR" });
    return override;
  }
  const root = resolveAssetRoot();
  const candidates = [join(root, "webui"), join(root, "webui", "dist")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) {
      log.debug("web-dist.resolved", { dir, reason: "asset-root" });
      return dir;
    }
  }
  log.warn("web-dist.unresolved", {
    reason: "no index.html under <asset-root>/webui or <asset-root>/webui/dist — the UI will 404",
    candidates,
  });
  return undefined;
}
