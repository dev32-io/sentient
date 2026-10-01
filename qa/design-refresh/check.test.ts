import { execFileSync } from "node:child_process";
import { sourceIdentity, sha256 } from "../../tools/visual-diff/evidence.mjs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventorySchema } from "./contracts.ts";
import { assertImplementationInventoryClosed, discoverReachability, findPrototypeRuntimeReferences, validateAssetCopy, validateInventory, validateMatrix, validateVisualManifest } from "./check.ts";
import { assertLoopbackFixtureTarget, withDisposableUser } from "./fixture.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const temporary: string[] = [];
async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "design-refresh-check-"));
  temporary.push(path);
  return path;
}
async function current(name: string): Promise<any> {
  return Bun.file(resolve(import.meta.dir, name)).json();
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("design refresh inventory checker", () => {
  it("rejects a missing reachable row", async () => {
    const raw = await current("inventory.json");
    const reachability = await discoverReachability(repoRoot);
    raw.rows = raw.rows.slice(1);
    await expect(validateInventory(repoRoot, raw, reachability)).rejects.toThrow("missing reachable inventory rows");
  });

  it("rejects an open implementation inventory", async () => {
    const inventory = inventorySchema.parse(await current("inventory.json"));
    inventory.rows[0].status = "planned";
    expect(() => assertImplementationInventoryClosed(inventory)).toThrow("implementation inventory is not closed");
  });

  it("rejects a duplicate final E2E mapping", async () => {
    const inventory = inventorySchema.parse(await current("inventory.json"));
    const matrix = await current("e2e-matrix.json");
    matrix.cases.push(structuredClone(matrix.cases[0]));
    await expect(validateMatrix(matrix, inventory)).rejects.toThrow("duplicate E2E cases");
  });

  it("rejects multiline imports, URLs, and bundle references to prototypes", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "gateway/webui/src"), { recursive: true });
    await mkdir(join(root, "ios/App"), { recursive: true });
    await writeFile(join(root, "gateway/webui/src/example.ts"), [
      "// design/prototype/reference-only is allowed in comments",
      "import recipe from",
      '  "../../../design/prototype/calendar/calendar.js";',
      'const asset = new URL("../../../design/prototype/avatar.riv", import.meta.url);',
    ].join("\n"));
    await writeFile(join(root, "ios/App/Example.swift"), [
      "let asset = Bundle.main.url(",
      '  forResource: "design/prototype/avatar",',
      '  withExtension: "riv")',
    ].join("\n"));
    await expect(findPrototypeRuntimeReferences(root)).resolves.toEqual([
      "gateway/webui/src/example.ts:3",
      "gateway/webui/src/example.ts:4",
      "ios/App/Example.swift:2",
    ]);
  });

  it("accepts a platform-owned asset copy with the recorded canonical hash", async () => {
    const root = await tempRoot();
    const canonicalPath = "design/prototype/foundation-components/example.riv";
    const productionPath = "ios/App/Resources/example.riv";
    await mkdir(resolve(root, "design/prototype/foundation-components"), { recursive: true });
    await mkdir(resolve(root, "ios/App/Resources"), { recursive: true });
    await writeFile(resolve(root, canonicalPath), "canonical bytes");
    await writeFile(resolve(root, productionPath), "canonical bytes");
    await expect(validateAssetCopy(root, {
      canonicalPath,
      productionPath,
      canonicalSha256: createHash("sha256").update("canonical bytes").digest("hex"),
    })).resolves.toBeUndefined();
  });

  it("rejects evidence containing secret-like or production identifiers", async () => {
    const root = await tempRoot();
    const path = "qa/web/evidence/design-refresh/case.txt";
    await mkdir(resolve(root, "qa/web/evidence/design-refresh"), { recursive: true });
    await writeFile(resolve(root, path), "authorization: Bearer example-sensitive-value\n");
    const inventory = inventorySchema.parse(await current("inventory.json"));
    const manifest = await current("visual-review.json");
    manifest.entries[0].status = "reviewed";
    manifest.entries[0].evidencePaths = [path];
    await expect(validateVisualManifest(root, manifest, inventory)).rejects.toThrow("unsanitized evidence");
  });

  it("rejects reviewed status without render evidence for every required configuration", async () => {
    const root = await tempRoot();
    const path = "qa/web/evidence/design-refresh/review.txt";
    await mkdir(resolve(root, "qa/web/evidence/design-refresh"), { recursive: true });
    await writeFile(resolve(root, path), "Synthetic visual review observation.\n");
    const inventory = inventorySchema.parse(await current("inventory.json"));
    const manifest = await current("visual-review.json");
    const entry = manifest.entries[0];
    entry.status = "reviewed";
    entry.evidencePaths = [path];
    entry.reviewerNotes = "Reviewed the rendered synthetic fixture for layout and interaction behavior.";
    entry.measurements = {
      overflow: { applicable: false, reason: "The loading surface has no overflowing content region." },
      minimumTarget: { applicable: false, reason: "The loading surface has no interactive target." },
      focus: { applicable: false, reason: "The loading surface has no focusable control." },
    };
    await expect(validateVisualManifest(root, manifest, inventory)).rejects.toThrow("render evidence does not cover configurations");
  });

  it("rejects legacy sidecars with synthetic bytes and no provenance", async () => {
    const root = await tempRoot();
    const evidenceRoot = "qa/web/evidence/design-refresh";
    await mkdir(resolve(root, evidenceRoot), { recursive: true });
    const inventory = inventorySchema.parse(await current("inventory.json"));
    const manifest = await current("visual-review.json");
    for (const pending of manifest.entries.slice(1)) {
      pending.status = "pending";
      pending.evidencePaths = [];
    }
    const entry = manifest.entries[0];
    const captures = entry.configurations.map((configuration: string) => ({
      configuration,
      path: `${evidenceRoot}/${configuration}.png`,
    }));
    for (const capture of captures) await writeFile(resolve(root, capture.path), "synthetic image bytes");
    const sidecar = `${evidenceRoot}/capture.json`;
    await writeFile(resolve(root, sidecar), JSON.stringify({
      version: 1,
      kind: "design-refresh-visual-evidence",
      platform: "web",
      inventoryIds: [entry.inventoryId],
      captures,
      observations: captures.map((capture: { configuration: string }) => ({
        inventoryId: entry.inventoryId,
        configuration: capture.configuration,
        overflow: 0,
        minimumTarget: null,
        focusableCount: 0,
      })),
    }));
    entry.status = "reviewed";
    entry.evidencePaths = [sidecar, ...captures.map((capture: { path: string }) => capture.path)];
    entry.reviewerNotes = "Reviewed the rendered synthetic fixture for layout and interaction behavior.";
    entry.measurements = {
      overflow: { applicable: false, reason: "The loading surface has no overflowing content region." },
      minimumTarget: { applicable: false, reason: "The loading surface has no interactive target." },
      focus: { applicable: false, reason: "The loading surface has no focusable control." },
    };
    await expect(validateVisualManifest(root, manifest, inventory)).rejects.toThrow("missing capture provenance");
  });

  it("closes only fresh production images with consistent passing observations; unknown and failures stay open", async () => {
    const root = await tempRoot();
    execFileSync("git", ["init", "-q", root]);
    const inventory = inventorySchema.parse(await current("inventory.json"));
    inventory.rows = [inventory.rows[0]!];
    const row = inventory.rows[0]!;
    row.requiredConfigurations = [row.requiredConfigurations[0]!];
    const manifest = await current("visual-review.json");
    manifest.entries = [manifest.entries[0]];
    const entry = manifest.entries[0];
    entry.configurations = row.requiredConfigurations;
    entry.status = "reviewed";
    entry.reviewerNotes = "Reviewed disposable production fixture.";
    entry.measurements = {
      overflow: { applicable: true, value: 0, unit: "css-px", result: "pass" },
      minimumTarget: { applicable: false, reason: "No interactive target." },
      focus: { applicable: false, reason: "No focusable control." },
    };
    await mkdir(dirname(resolve(root, row.implementationPath)), { recursive: true });
    await writeFile(resolve(root, row.implementationPath), "// synthetic source\n");
    execFileSync("git", ["add", "."], { cwd: root });
    const prefix = "qa/web/evidence/design-refresh/";
    await mkdir(resolve(root, prefix), { recursive: true });
    const actual = prefix + "actual.png";
    await writeFile(resolve(root, actual), await Bun.file(resolve(repoRoot, "design/prototype/foundation-components/handoff/static/action-button--primary--rest.png")).arrayBuffer());
    const provenancePath = prefix + "provenance.json";
    const provenance = {
      version: 1, platform: "web", origin: "production-component", inventoryId: row.id,
      implementationPath: row.implementationPath, fixtureId: row.id, capturedAt: new Date().toISOString(),
      sourceSha256: await sourceIdentity(root, "web"), actualSha256: await sha256(resolve(root, actual)),
      actualPath: actual, dimensions: { width: 312, height: 176 }, runtime: { browser: "test" },
      viewport: { width: 156, height: 88, scale: 2 }, configuration: { id: entry.configurations[0], fontSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", themeSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      measurements: { overflow: 0, minimumTarget: null, focus: 0 },
    };
    await writeFile(resolve(root, provenancePath), JSON.stringify(provenance));
    const sidecar = prefix + "capture.json";
    const doc = {
      version: 1, kind: "design-refresh-visual-evidence", platform: "web", inventoryIds: [row.id],
      captures: [{ configuration: entry.configurations[0], path: actual, provenancePath }],
      observations: [{ inventoryId: row.id, configuration: entry.configurations[0], overflow: 0, minimumTarget: null as number | null, focusableCount: 0 as number | null }],
    };
    await writeFile(resolve(root, sidecar), JSON.stringify(doc));
    entry.evidencePaths = [sidecar, actual, provenancePath];
    await expect(validateVisualManifest(root, manifest, inventory)).resolves.toBeDefined();
    for (const measure of [
      { applicable: true, value: 0, unit: "css-px", result: "needs-review" },
      { applicable: "unknown", reason: "Native measurement unavailable." },
    ]) {
      entry.measurements.overflow = measure;
      await expect(validateVisualManifest(root, manifest, inventory)).rejects.toThrow("failed/unknown");
    }
    entry.measurements.overflow = { applicable: true, value: 0, unit: "css-px", result: "pass" };
    doc.observations[0]!.overflow = 999;
    doc.observations[0]!.minimumTarget = 0;
    await writeFile(resolve(root, sidecar), JSON.stringify(doc));
    await expect(validateVisualManifest(root, manifest, inventory)).rejects.toThrow("observations disagree");
    doc.observations[0]!.overflow = 0;
    doc.observations[0]!.focusableCount = null;
    await writeFile(resolve(root, sidecar), JSON.stringify(doc));
    await expect(validateVisualManifest(root, manifest, inventory)).rejects.toThrow("unknown measurements");
    doc.observations[0]!.focusableCount = 0;
    doc.observations[0]!.minimumTarget = null;
    await writeFile(resolve(root, sidecar), JSON.stringify(doc));
    await writeFile(resolve(root, row.implementationPath), "// changed source\n");
    await expect(validateVisualManifest(root, manifest, inventory)).rejects.toThrow("Stale/source-incompatible");
  });

  it("accepts only explicit local loopback fixture targets", () => {
    expect(() => assertLoopbackFixtureTarget("https://localhost/", "local")).not.toThrow();
    expect(() => assertLoopbackFixtureTarget("http://127.0.0.1:8888/", "local")).not.toThrow();
    expect(() => assertLoopbackFixtureTarget("https://gateway.example/", "local")).toThrow("loopback");
    expect(() => assertLoopbackFixtureTarget("https://localhost/", "production")).toThrow("explicit local");
  });

  it("deletes the whole disposable user after a failed case", async () => {
    const users = new Set<string>();
    const deleted: string[] = [];
    const adapter = {
      createUser: async () => { users.add("u_synthetic1"); return { userId: "u_synthetic1" }; },
      deleteUser: async (userId: string) => { users.delete(userId); deleted.push(userId); },
    };
    await expect(withDisposableUser(adapter, "1234", async () => { throw new Error("case failed"); })).rejects.toThrow("case failed");
    expect(users.size).toBe(0);
    expect(deleted).toEqual(["u_synthetic1"]);
  });
});
