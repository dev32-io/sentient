import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventorySchema } from "./contracts.ts";
import { findPrototypeRuntimeReferences, validateAssetCopy, validateInventory, validateMatrix, validateVisualManifest } from "./check.ts";
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
    const required = (await current("reachability.json")).requiredIds as string[];
    raw.rows = raw.rows.slice(1);
    await expect(validateInventory(repoRoot, raw, required)).rejects.toThrow("missing reachable inventory rows");
  });

  it("rejects a duplicate final E2E mapping", async () => {
    const inventory = inventorySchema.parse(await current("inventory.json"));
    const matrix = await current("e2e-matrix.json");
    matrix.cases.push(structuredClone(matrix.cases[0]));
    await expect(validateMatrix(matrix, inventory)).rejects.toThrow("duplicate E2E cases");
  });

  it("rejects production runtime imports from prototypes", async () => {
    const root = await tempRoot();
    const source = join(root, "gateway/webui/src/example.ts");
    await mkdir(join(root, "gateway/webui/src"), { recursive: true });
    await writeFile(source, 'import recipe from "../../../design/prototype/calendar/calendar.js";\n');
    await expect(findPrototypeRuntimeReferences(root)).resolves.toEqual(["gateway/webui/src/example.ts:1"]);
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
