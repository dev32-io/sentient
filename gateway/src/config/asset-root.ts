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

/** Sibling directory that marks a `webui/` directory as tracked Vite SOURCE
 *  rather than a built bundle. `webui/index.html` is committed source that
 *  exists in EVERY checkout whether or not anything has been built — running
 *  the build only ever adds `webui/dist/`, it never removes `webui/src/`. An
 *  installed release's `share/webui/` is copied straight from `webui/dist/`
 *  (scripts/build-gateway.sh) and so never carries a `src/` sibling. That
 *  absence is the only thing distinguishing a real bundle sitting at
 *  `webui/index.html` from committed pre-bundle source at the same path. */
const WEBUI_SOURCE_SENTINEL = "src";

/** Where the BUILT web bundle lives, or undefined when nothing has been built.
 *
 *  Three shapes, and PROBE ORDER matters — checking bare `webui/` before
 *  `webui/dist/` is a live bug, not a style choice. `webui/index.html` is
 *  TRACKED VITE SOURCE present in every checkout regardless of build state,
 *  so a naive first-match-wins scan over [webui, webui/dist] always matches
 *  the source directory and never reaches dist. Serving that hands the
 *  browser raw pre-bundle HTML referencing `/src/main.tsx`, which the browser
 *  cannot run.
 *
 *    installed release   share/webui/index.html          -> share/webui
 *    repo, built          webui/dist/index.html            -> webui/dist   (gitignored build output)
 *    repo, NOT built       webui/index.html (source only)   -> undefined    (clean 404, never raw source)
 *
 *  `webui/dist/index.html` is probed FIRST: it exists in exactly one shape
 *  (repo + built) and is unambiguous whenever present. Only on a miss do we
 *  consider bare `webui/index.html`, and even then only when `webui/` is NOT
 *  a Vite source tree (no WEBUI_SOURCE_SENTINEL sibling) — that guard is what
 *  makes the third row return undefined instead of serving unbuilt source.
 *  Do not swap the probe order or drop the guard "to simplify" — either
 *  change reintroduces the bug this comment is describing.
 *
 *  `WEB_DIST_DIR` stays as an override for operators pointing at a bundle
 *  outside either layout. Returns undefined rather than throwing: a gateway
 *  with no UI still serves the API, and the launcher builds the bundle before
 *  start (scripts/stack.sh). */
export function resolveWebDistDir(): string | undefined {
  const override = process.env.WEB_DIST_DIR;
  if (override !== undefined && override.length > 0) {
    log.debug("web-dist.resolved", { dir: override, reason: "WEB_DIST_DIR" });
    return override;
  }

  const root = resolveAssetRoot();

  const distDir = join(root, "webui", "dist");
  if (existsSync(join(distDir, "index.html"))) {
    log.debug("web-dist.resolved", { dir: distDir, reason: "asset-root" });
    return distDir;
  }

  const webuiDir = join(root, "webui");
  const isSourceTree = existsSync(join(webuiDir, WEBUI_SOURCE_SENTINEL));
  if (!isSourceTree && existsSync(join(webuiDir, "index.html"))) {
    log.debug("web-dist.resolved", { dir: webuiDir, reason: "asset-root" });
    return webuiDir;
  }

  log.warn("web-dist.unresolved", {
    reason:
      "no built index.html under <asset-root>/webui/dist, and <asset-root>/webui is Vite source (or missing) — the UI will 404",
    candidates: [distDir, webuiDir],
  });
  return undefined;
}
