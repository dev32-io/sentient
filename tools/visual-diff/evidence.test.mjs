import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { beginEvidence, finishEvidence, sourceIdentity, validateEvidence } from "./evidence.mjs";
import { joinCoverage } from "./coverage.mjs";

const authority = "design/prototype/foundation-components/handoff/static/action-button--primary--rest.png";

test("evidence rejects stale sources, changed PNGs, wrong identities and generic production substitutes", async () => {
  const root = await mkdtemp(join(tmpdir(), "visual-evidence-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const source = join(root, "ios/App/Example.swift");
    const reference = join(root, authority);
    const actual = join(root, "build/visual-captures/ios/actual.png");
    await mkdir(join(root, "ios/App"), { recursive: true });
    await mkdir(join(root, "design/prototype/foundation-components/handoff/static"), { recursive: true });
    await writeFile(source, "// source v1\n");
    execFileSync("git", ["add", "."], { cwd: root });
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    const bytes = PNG.sync.write(png);
    await writeFile(reference, bytes);
    await mkdir(join(root, "build/visual-captures/ios"), { recursive: true });
    await writeFile(actual, bytes);
    await beginEvidence(root, reference, actual, "ios");
    const metadata = {
      fixtureId: "action-button--primary--rest", origin: "production-component",
      inventoryId: "ios.example", implementationPath: "ios/App/Example.swift",
      runtime: { os: "test-runtime" }, viewport: { width: 1, height: 1, scale: 2 },
      configuration: { fontSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", themeSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    };
    const evidence = await finishEvidence(root, reference, actual, "ios", metadata);
    const expected = { reference, actual, platform: "ios", inventoryId: "ios.example", implementationPath: "ios/App/Example.swift" };
    await assert.doesNotReject(() => validateEvidence(root, evidence, expected));
    await assert.rejects(() => beginEvidence(root, join(root, "design/prototype/chat-composer/handoff/recordings/voice-control--auto-loop/frame-000--0000ms.png"), actual, "ios"), /another canonical case/);
    await assert.rejects(() => validateEvidence(root, { ...evidence, fixtureId: "segmented-control--comfortable-to-compact--frame-000--0000ms" }, expected), /fixture identity mismatch/);
    await assert.rejects(() => validateEvidence(root, { ...evidence, runtime: {} }, expected), /Unknown runtime/);
    await assert.rejects(() => validateEvidence(root, { ...evidence, origin: "generic-specimen" }, expected), /cannot close production/);
    await assert.rejects(() => validateEvidence(root, evidence, { ...expected, inventoryId: "ios.other" }), /identity mismatch/);
    await assert.rejects(() => validateEvidence(root, { ...evidence, configuration: {} }, expected), /font\/theme/);
    await writeFile(actual, "not a PNG");
    await assert.rejects(() => validateEvidence(root, evidence, expected), /hash mismatch/);
    await writeFile(actual, bytes);
    await writeFile(source, "// source v2\n");
    await assert.rejects(() => validateEvidence(root, evidence, expected), /Stale\/source-incompatible/);
    await assert.rejects(() => finishEvidence(root, reference, actual, "ios", metadata), /changed during capture/);
    await writeFile(source, "// source v1\n");
    await writeFile(reference, Buffer.concat([await readFile(reference), Buffer.from("changed")]));
    await assert.rejects(() => validateEvidence(root, evidence, expected), /Stale\/source-incompatible/);
    // Untracked reference resources now bind source identity too. Refresh only
    // that field to independently exercise the reference hash boundary.
    await assert.rejects(async () => validateEvidence(root, { ...evidence, sourceSha256: await sourceIdentity(root, "ios") }, expected), /Reference identity\/hash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coverage joins exact fixtures, keeps unknown motion missing, and never treats registration as pass", () => {
  const motion = "design/prototype/chat-composer/handoff/recordings/voice-control--auto-loop/frame-000--0000ms.png";
  const fixture = { fixtureId: "action-button--primary--rest", componentId: "action-button", applicability: "supported" };
  const rows = joinCoverage([authority, motion], [fixture], new Set());
  assert.equal(rows[0].status, "real-fixture");
  assert.equal(rows[0].visualPass, false);
  assert.equal(rows[1].status, "missing");
  assert.equal(rows[1].motionProof, false);
  assert.equal(joinCoverage([authority], null, new Set(["action-button"]))[0].status, "needs-review");
  assert.throws(() => joinCoverage([authority], [fixture, fixture], new Set()), /duplicate fixture/);
  assert.throws(() => joinCoverage([authority], [{ ...fixture, componentId: "segmented-control" }], new Set()), /Wrong component/);
  assert.throws(() => joinCoverage([authority, authority], [fixture], new Set()), /Duplicate authority/);
});
