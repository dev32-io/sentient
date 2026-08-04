import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assetPath, resetAssetRootForTest, resolveAssetRoot, resolveWebDistDir } from "./asset-root.ts";

function withRuntimeDir(value: string | undefined, body: () => void): void {
  const prev = process.env.GATEWAY_RUNTIME_DIR;
  // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
  if (value === undefined) delete process.env.GATEWAY_RUNTIME_DIR;
  else process.env.GATEWAY_RUNTIME_DIR = value;
  resetAssetRootForTest();
  try {
    body();
  } finally {
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    if (prev === undefined) delete process.env.GATEWAY_RUNTIME_DIR;
    else process.env.GATEWAY_RUNTIME_DIR = prev;
    resetAssetRootForTest();
  }
}

describe("asset-root", () => {
  it("CONTRACT: honours GATEWAY_RUNTIME_DIR when set", () => {
    withRuntimeDir("/tmp/sentient-assets-fixture", () => {
      expect(resolveAssetRoot()).toBe("/tmp/sentient-assets-fixture");
    });
  });

  it("INVARIANT: throws an actionable error instead of returning a bogus root", () => {
    withRuntimeDir("/definitely/not/a/real/asset/root", () => {
      expect(() => assetPath("templates")).toThrow(/GATEWAY_RUNTIME_DIR/);
    });
  });

  it("resolves a real asset that ships with the repo", () => {
    withRuntimeDir(undefined, () => {
      expect(existsSync(assetPath("templates"))).toBe(true);
    });
  });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "asset-root-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  return root;
}

afterEach(() => {
  resetAssetRootForTest();
  // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
  delete process.env.GATEWAY_RUNTIME_DIR;
  // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
  delete process.env.WEB_DIST_DIR;
});

describe("resolveWebDistDir", () => {
  it("returns <root>/webui when that directory holds index.html (installed release)", () => {
    const root = makeRoot();
    mkdirSync(join(root, "webui"), { recursive: true });
    writeFileSync(join(root, "webui", "index.html"), "<html></html>");
    process.env.GATEWAY_RUNTIME_DIR = root;

    expect(resolveWebDistDir()).toBe(join(root, "webui"));
  });

  it("returns <root>/webui/dist when webui/ is a source tree (repo checkout)", () => {
    const root = makeRoot();
    mkdirSync(join(root, "webui", "dist"), { recursive: true });
    writeFileSync(join(root, "webui", "dist", "index.html"), "<html></html>");
    process.env.GATEWAY_RUNTIME_DIR = root;

    expect(resolveWebDistDir()).toBe(join(root, "webui", "dist"));
  });

  it("returns undefined when no bundle has been built", () => {
    const root = makeRoot();
    mkdirSync(join(root, "webui"), { recursive: true });
    process.env.GATEWAY_RUNTIME_DIR = root;

    expect(resolveWebDistDir()).toBeUndefined();
  });

  it("prefers WEB_DIST_DIR over the asset root when set", () => {
    const root = makeRoot();
    const override = mkdtempSync(join(tmpdir(), "web-override-"));
    writeFileSync(join(override, "index.html"), "<html></html>");
    process.env.GATEWAY_RUNTIME_DIR = root;
    process.env.WEB_DIST_DIR = override;

    expect(resolveWebDistDir()).toBe(override);
  });
});
