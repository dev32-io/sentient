#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { e2eMatrixSchema, inventorySchema, visualManifestSchema, type Inventory, type VisualManifest } from "./contracts.ts";

export const EXPECTED_CASES = Array.from({ length: 9 }, (_, i) => `E2E-${String(i + 1).padStart(3, "0")}`);
const PRODUCTION_ROOTS = ["gateway/webui/src", "ios/App", "shared/mobile-sdk/src", "shared/mobile-data/src"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".swift", ".kt", ".kts", ".css"]);
const EVIDENCE_ROOTS = ["qa/web/evidence/design-refresh/", "qa/mobile/evidence/design-refresh/"];
const EVIDENCE_EXTENSIONS = new Set([".json", ".md", ".txt", ".png", ".jpg", ".jpeg", ".mp4"]);
const TEXT_EVIDENCE_EXTENSIONS = new Set([".json", ".md", ".txt"]);
const UNSAFE_EVIDENCE = [
  /\b(?:password|credential|bearer|authorization|access[_ -]?token|refresh[_ -]?token|pin\s*[:=])\b/i,
  /\b(?:transcript|raw audio|microphone capture|private household|production (?:user|event|session|identifier)|system prompt|user prompt)\b/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+|u_[a-f0-9]{8,})\b/,
];

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) seen.has(value) ? duplicate.add(value) : seen.add(value);
  return [...duplicate].sort();
}

async function regularFile(repoRoot: string, path: string): Promise<boolean> {
  try {
    return (await lstat(resolve(repoRoot, path))).isFile();
  } catch {
    return false;
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function walk(path: string): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(child)));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

export async function findPrototypeRuntimeReferences(repoRoot: string): Promise<string[]> {
  const violations: string[] = [];
  const runtimePattern = /(?:\bimport\b[^\n]*\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bBun\.file\s*\(|\breadFile(?:Sync)?\s*\(|\bnew\s+URL\s*\(|\burl\s*\()[^\n]*design\/prototype\//;
  for (const root of PRODUCTION_ROOTS) {
    for (const absolute of await walk(resolve(repoRoot, root))) {
      if (!SOURCE_EXTENSIONS.has(extname(absolute))) continue;
      const lines = (await readFile(absolute, "utf8")).split("\n");
      lines.forEach((line, index) => {
        if (runtimePattern.test(line)) violations.push(`${relative(repoRoot, absolute)}:${index + 1}`);
      });
    }
  }
  return violations.sort();
}

export async function validateAssetCopy(
  repoRoot: string,
  asset: { canonicalPath: string; productionPath: string; canonicalSha256: string },
  ownerId = "asset",
): Promise<void> {
  if (asset.productionPath.startsWith("design/prototype/")) throw new Error(`${ownerId}: production asset must be platform-owned`);
  const canonical = resolve(repoRoot, asset.canonicalPath);
  const production = resolve(repoRoot, asset.productionPath);
  if (!(await regularFile(repoRoot, asset.canonicalPath)) || !(await regularFile(repoRoot, asset.productionPath))) {
    throw new Error(`${ownerId}: asset copy path is not a regular file`);
  }
  const canonicalHash = await sha256(canonical);
  const productionHash = await sha256(production);
  if (canonicalHash !== asset.canonicalSha256 || productionHash !== canonicalHash) throw new Error(`${ownerId}: platform asset copy hash mismatch`);
}

export async function validateInventory(repoRoot: string, raw: unknown, requiredIds: readonly string[]): Promise<Inventory> {
  const inventory = inventorySchema.parse(raw);
  const ids = inventory.rows.map((row) => row.id);
  const duplicateIds = duplicates(ids);
  if (duplicateIds.length) throw new Error(`duplicate inventory IDs: ${duplicateIds.join(", ")}`);
  const missing = requiredIds.filter((id) => !ids.includes(id));
  if (missing.length) throw new Error(`missing reachable inventory rows: ${missing.join(", ")}`);
  const unknown = ids.filter((id) => !requiredIds.includes(id));
  if (unknown.length) throw new Error(`inventory rows absent from closed reachability contract: ${unknown.join(", ")}`);

  for (const root of inventory.roots) {
    if (!(await regularFile(repoRoot, root))) throw new Error(`reachability root is not a regular file: ${root}`);
  }
  for (const row of inventory.rows) {
    if (!(row.taskOwner in inventory.owners)) throw new Error(`${row.id}: unknown task owner ${row.taskOwner}`);
    if (!(await regularFile(repoRoot, row.implementationPath))) throw new Error(`${row.id}: implementation path is not a regular file: ${row.implementationPath}`);
    for (const config of row.requiredConfigurations) {
      const definition = inventory.configurations[config];
      if (!definition || definition.platform !== row.platform) throw new Error(`${row.id}: invalid configuration ${config}`);
    }
    for (const asset of row.assetCopies) await validateAssetCopy(repoRoot, asset, row.id);
  }
  const prototypeRefs = await findPrototypeRuntimeReferences(repoRoot);
  if (prototypeRefs.length) throw new Error(`production runtime references design/prototype: ${prototypeRefs.join(", ")}`);
  return inventory;
}

export async function validateMatrix(raw: unknown, inventory: Inventory): Promise<void> {
  const matrix = e2eMatrixSchema.parse(raw);
  const ids = matrix.cases.map((entry) => entry.id);
  const duplicateIds = duplicates(ids);
  if (duplicateIds.length) throw new Error(`duplicate E2E cases: ${duplicateIds.join(", ")}`);
  const sorted = [...ids].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(EXPECTED_CASES)) throw new Error(`E2E matrix must map E2E-001..009 exactly once`);
  const inventoryIds = new Set(inventory.rows.map((row) => row.id));
  for (const entry of matrix.cases) {
    for (const id of entry.inventoryIds) if (!inventoryIds.has(id)) throw new Error(`${entry.id}: unknown inventory mapping ${id}`);
    if (entry.platform === "web" && entry.id > "E2E-005") throw new Error(`${entry.id}: platform mismatch`);
    if (entry.platform === "ios" && entry.id < "E2E-006") throw new Error(`${entry.id}: platform mismatch`);
  }
}

export async function validateVisualManifest(repoRoot: string, raw: unknown, inventory: Inventory): Promise<VisualManifest> {
  const manifest = visualManifestSchema.parse(raw);
  const evidenceIds = manifest.entries.map((entry) => entry.evidenceId);
  const duplicateIds = duplicates(evidenceIds);
  if (duplicateIds.length) throw new Error(`duplicate visual evidence IDs: ${duplicateIds.join(", ")}`);
  const duplicateInventoryIds = duplicates(manifest.entries.map((entry) => entry.inventoryId));
  if (duplicateInventoryIds.length) throw new Error(`duplicate visual inventory mappings: ${duplicateInventoryIds.join(", ")}`);
  const byInventory = new Map(manifest.entries.map((entry) => [entry.inventoryId, entry]));
  for (const row of inventory.rows) {
    const entry = byInventory.get(row.id);
    if (!entry) throw new Error(`${row.id}: missing visual review manifest entry`);
    if (entry.configurations.slice().sort().join("|") !== row.requiredConfigurations.slice().sort().join("|")) throw new Error(`${row.id}: visual configurations do not match inventory`);
    for (const id of row.visualEvidenceIds) if (!evidenceIds.includes(id)) throw new Error(`${row.id}: missing visual evidence reference ${id}`);
    if (row.platform === "ios" && entry.nativeAdaptation !== row.intentionalNativeAdaptation) throw new Error(`${row.id}: native adaptation was not carried into visual review`);
  }
  for (const entry of manifest.entries) {
    if (!inventory.rows.some((row) => row.id === entry.inventoryId)) throw new Error(`${entry.evidenceId}: unknown inventory row`);
    for (const path of entry.evidencePaths) {
      if (!EVIDENCE_ROOTS.some((root) => path.startsWith(root))) throw new Error(`${entry.evidenceId}: evidence path is outside a design-refresh evidence root`);
      const extension = extname(path).toLowerCase();
      if (!EVIDENCE_EXTENSIONS.has(extension)) throw new Error(`${entry.evidenceId}: prohibited evidence file type ${extension || "<none>"}`);
      if (!(await regularFile(repoRoot, path))) throw new Error(`${entry.evidenceId}: evidence must be a sanitized regular file: ${path}`);
      const content = TEXT_EVIDENCE_EXTENSIONS.has(extension) ? await readFile(resolve(repoRoot, path), "utf8") : "";
      if (UNSAFE_EVIDENCE.some((pattern) => pattern.test(`${path}\n${content}`))) throw new Error(`${entry.evidenceId}: unsanitized evidence content`);
    }
  }
  return manifest;
}

export async function checkRepository(repoRoot = resolve(import.meta.dir, "../.."), requireClosed = false): Promise<void> {
  const base = resolve(repoRoot, "qa/design-refresh");
  const requiredIds = (await json(resolve(base, "reachability.json")) as { requiredIds: string[] }).requiredIds;
  const inventory = await validateInventory(repoRoot, await json(resolve(base, "inventory.json")), requiredIds);
  await validateMatrix(await json(resolve(base, "e2e-matrix.json")), inventory);
  const visual = await validateVisualManifest(repoRoot, await json(resolve(base, "visual-review.json")), inventory);
  if (requireClosed) {
    const openRows = inventory.rows.filter((row) => row.status !== "reviewed" && row.status !== "unreachable" && row.status !== "excluded");
    const openEvidence = visual.entries.filter((entry) => entry.status !== "reviewed");
    if (openRows.length || openEvidence.length) throw new Error(`design refresh review is not closed (inventory=${openRows.length}, evidence=${openEvidence.length})`);
  }
}

if (import.meta.main) {
  await checkRepository(undefined, process.argv.includes("--require-closed"));
  process.stdout.write("design refresh inventory and review contracts are valid\n");
}
