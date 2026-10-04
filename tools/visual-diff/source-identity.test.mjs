import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { beginEvidence, finishEvidence, sha256, sourceIdentity, validateEvidence } from "./evidence.mjs";
import { coverageInventory } from "./coverage.mjs";

async function fixture(run) {
  const root = await mkdtemp("/tmp/material-source-");
  const put = async (path, bytes) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  };
  try {
    execFileSync("git", ["init", "-q", root]);
    await put("ios/App/Example.swift", 'import SwiftUI\nlet image = Image("Example")\n');
    await put("gateway/webui/src/example.ts", "export const example = true;\n");
    await put("ios/Tests/VisualDiffFixtureRegistry.swift", "private static let components: [Registration] = []\nstatic func resolve() {}\n");
    await put("qa/design-refresh/inventory.json", '{"rows":[]}');
    execFileSync("git", ["add", "."], { cwd: root });
    await run({ root, put });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("WV-5: untracked PNG create/change/remove invalidates capture, pending and registry provenance", async () => {
  await fixture(async ({ root, put }) => {
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    const bytes = PNG.sync.write(png);
    png.data.set([0, 0, 0, 255], 0);
    const changed = PNG.sync.write(png);
    const reference = join(root, "design/prototype/synthetic/handoff/static/example.png");
    const actual = join(root, "build/visual-captures/ios/actual.png");
    const registry = join(root, "build/visual-captures/ios/registry.json");
    const asset = "ios/App/Assets.xcassets/Example.imageset/example.png";
    await put("ios/App/Assets.xcassets/Example.imageset/Contents.json", '{"images":[{"filename":"example.png","idiom":"universal"}]}');
    for (const path of [reference, actual]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    await writeFile(registry, "[]");
    const metadata = { fixtureId: "example", runtime: { os: "synthetic" }, viewport: { width: 2, height: 2, scale: 1 }, configuration: { fontSha256: "a".repeat(64), themeSha256: "b".repeat(64) } };
    const baseline = await sourceIdentity(root, "ios");
    for (const mutate of [() => put(asset, bytes), () => put(asset, changed), () => rm(join(root, asset))]) {
      await beginEvidence(root, reference, actual, "ios");
      const evidence = await finishEvidence(root, reference, actual, "ios", metadata);
      await writeFile(registry + ".provenance.json", JSON.stringify({ sourceSha256: evidence.sourceSha256, registrySha256: await sha256(registry) }));
      await validateEvidence(root, evidence);
      await coverageInventory(root, registry);
      await mutate();
      assert.notEqual(await sourceIdentity(root, "ios"), evidence.sourceSha256);
      await assert.rejects(() => validateEvidence(root, evidence), /Stale\/source-incompatible/);
      await assert.rejects(() => finishEvidence(root, reference, actual, "ios", metadata), /changed during capture/);
      await assert.rejects(() => coverageInventory(root, registry), /Stale registry export/);
      assert.deepEqual(await readFile(reference), bytes);
      assert.deepEqual(await readFile(actual), bytes);
    }
    assert.equal(await sourceIdentity(root, "ios"), baseline);
  });
});

test("WV-5: native/web material resource policy is extension independent and staging independent", async () => {
  await fixture(async ({ root, put }) => {
    for (const [platform, base] of [["ios", "ios/App/Resources"], ["web", "gateway/webui/src/assets"]]) {
      for (const name of ["image.png", "font.ttf", "font.woff2", "animation.riv", "config.entitlements", "schema.sq", "resource.new-format", "extensionless"]) {
        const path = `${base}/${name}`;
        const before = await sourceIdentity(root, platform);
        await put(path, "synthetic material v1");
        const created = await sourceIdentity(root, platform);
        assert.notEqual(created, before, path);
        execFileSync("git", ["add", path], { cwd: root });
        assert.equal(await sourceIdentity(root, platform), created, `staging must not change policy: ${path}`);
        await put(path, "synthetic material v2");
        assert.notEqual(await sourceIdentity(root, platform), created, path);
        execFileSync("git", ["rm", "--cached", "-f", path], { cwd: root });
        await rm(join(root, path));
        assert.equal(await sourceIdentity(root, platform), before, path);
      }
    }
  });
});

test("WV-5: private paths stay unread, source aliases fail closed before hashing", async () => {
  await fixture(async ({ root, put }) => {
    const baseline = await sourceIdentity(root, "ios");
    for (const path of [".env", ".env.production", "private-state/capture.png", "user-state/session.json", "credentials.json", "credentials/token", "secrets.enc", "signing.p12", "signing.key", "Local.xcconfig"]) {
      const file = join(root, "ios/App", path);
      await mkdir(dirname(file), { recursive: true });
      await symlink(join(root, "missing-private-sentinel"), file);
    }
    assert.equal(await sourceIdentity(root, "ios"), baseline);
    execFileSync("git", ["add", "."], { cwd: root });
    assert.equal(await sourceIdentity(root, "ios"), baseline);
    await put("outside/input", "synthetic outside bytes");
    const alias = join(root, "ios/App/resource.png");
    for (const makeAlias of [symlink, link]) {
      await makeAlias(join(root, "outside/input"), alias);
      await assert.rejects(() => sourceIdentity(root, "ios"), /unaliased regular file/);
      await rm(alias);
    }
    await put("ios/App/Assets/example.png", "synthetic material");
    execFileSync("git", ["add", "ios/App/Assets"], { cwd: root });
    await rename(join(root, "ios/App/Assets"), join(root, "outside/Assets"));
    await symlink(join(root, "outside/Assets"), join(root, "ios/App/Assets"));
    await assert.rejects(() => sourceIdentity(root, "ios"), /unaliased regular file/);
  });
});
