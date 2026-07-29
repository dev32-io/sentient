import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { assetPath, resetAssetRootForTest, resolveAssetRoot } from "./asset-root.ts";

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
