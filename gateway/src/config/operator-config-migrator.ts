import { readFileSync, writeFileSync } from "node:fs";
import { type Document, type YAMLMap, isMap, isScalar, parseDocument } from "yaml";
import { getLog } from "../logging/logger.ts";
import { writeFileAtomic } from "../user-auth/atomic-write.ts";

const log = getLog(["sentient", "config", "migration", "operator-config-web-tools"]);

// ---------------------------------------------------------------------------
// migrateOperatorConfigYaml
//
// Runs BEFORE the zod schema validates the operator's config.yaml. Rewrites
// legacy `hermes.web_tools.provider: duckduckgo` → `searxng` and drops the
// `hermes.web_tools.duckduckgo` sub-block, ensuring `hermes.web_tools.searxng:
// { enabled: true }` exists. Uses yaml's Document API to preserve comments
// and unrelated keys. Idempotent: no write when already migrated.
// ---------------------------------------------------------------------------

interface MigrationResult {
  providerRewritten: boolean;
  duckduckgoDropped: boolean;
  searxngAdded: boolean;
}

function applyWebToolsMigration(doc: Document): MigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  const hermesNode = root.get("hermes", true);
  if (!isMap(hermesNode)) return null;

  const webToolsNode = (hermesNode as YAMLMap).get("web_tools", true);
  if (!isMap(webToolsNode)) return null;

  const webTools = webToolsNode as YAMLMap;

  const providerNode = webTools.get("provider", true);
  const currentProvider = isScalar(providerNode) ? String(providerNode.value) : null;

  if (currentProvider !== "duckduckgo") return null;

  const result: MigrationResult = {
    providerRewritten: false,
    duckduckgoDropped: false,
    searxngAdded: false,
  };

  // Rewrite provider value
  webTools.set("provider", "searxng");
  result.providerRewritten = true;

  // Drop duckduckgo sub-block if present
  const hasDdg = webTools.has("duckduckgo");
  if (hasDdg) {
    webTools.delete("duckduckgo");
    result.duckduckgoDropped = true;
  }

  // Ensure searxng.enabled: true exists
  const existingSearxng = webTools.get("searxng", true);
  if (!isMap(existingSearxng)) {
    webTools.set("searxng", doc.createNode({ enabled: true }));
    result.searxngAdded = true;
  }

  return result;
}

/**
 * Sync variant used by `loadStartupConfig` (which is sync).
 * Reads `configPath`, applies the duckduckgo→searxng migration if needed,
 * and writes back atomically. No-op if already migrated. Errors are logged
 * as warnings; the caller continues — the schema will surface the mismatch
 * if migration somehow fails.
 */
export function migrateOperatorConfigYamlSync(configPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e: unknown) {
    log.warn("read-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  let doc: Document;
  try {
    doc = parseDocument(raw);
  } catch (e: unknown) {
    log.warn("parse-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  const result = applyWebToolsMigration(doc);
  if (result === null) {
    // Already migrated or no hermes.web_tools block — pure no-op.
    return;
  }

  const updated = doc.toString();
  try {
    writeFileSync(configPath, updated, { encoding: "utf-8" });
  } catch (e: unknown) {
    log.warn("write-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  log.info("migrated", {
    path: configPath,
    providerRewritten: result.providerRewritten,
    duckduckgoDropped: result.duckduckgoDropped,
    searxngAdded: result.searxngAdded,
  });
}

/**
 * Async variant with true atomic write (tmp→rename). Used in contexts where
 * async is already available (e.g. tests, future async boot path).
 */
export async function migrateOperatorConfigYaml(configPath: string): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e: unknown) {
    log.warn("read-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  let doc: Document;
  try {
    doc = parseDocument(raw);
  } catch (e: unknown) {
    log.warn("parse-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  const result = applyWebToolsMigration(doc);
  if (result === null) {
    return;
  }

  const updated = doc.toString();
  try {
    await writeFileAtomic(configPath, updated);
  } catch (e: unknown) {
    log.warn("write-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  log.info("migrated", {
    path: configPath,
    providerRewritten: result.providerRewritten,
    duckduckgoDropped: result.duckduckgoDropped,
    searxngAdded: result.searxngAdded,
  });
}
