import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertDisposableOutput, caseIdFromReference, defaultActualPath, fixtureIdFromReference, readPngSize } from "./reference-image.mjs";

const onePixelPng = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

test("reads PNG dimensions without a rendering dependency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentient-visual-diff-"));
  const path = join(directory, "action-button--primary--rest.png");
  await writeFile(path, onePixelPng);
  assert.deepEqual(await readPngSize(path), { width: 1, height: 1 });
});

test("rejects outputs outside the disposable platform directory", async () => {
  const reference = resolve("design/reference.png");
  await assert.doesNotReject(() => assertDisposableOutput(reference, resolve("build/visual-captures/web/actual.png"), "web"));
  await assert.rejects(() => assertDisposableOutput(reference, reference, "web"), /must not overwrite/);
  await assert.rejects(() => assertDisposableOutput(reference, resolve("design/actual.png"), "web"), /must stay under/);
});

test("derives stable case and implementation output names", () => {
  const reference = "design/prototype/foundation-components/handoff/static/action-button--primary--rest.png";
  assert.equal(caseIdFromReference(reference), "foundation-components/static/action-button--primary--rest");
  assert.match(defaultActualPath(reference, "ios"), /build\/visual-captures\/ios\/foundation-components\/static\/action-button--primary--rest\.png$/);
});

test("recording frame identities and outputs cannot collide or fall back to segmented", () => {
  const references = ["foundation-components/segmented-control--comfortable-to-compact", "chat-composer/voice-control--auto-loop", "chat-composer/composer--idle-to-hold"].map(id => {
    const [prototype, recording] = id.split("/");
    return `design/prototype/${prototype}/handoff/recordings/${recording}/frame-000--0000ms.png`;
  });
  assert.equal(new Set(references.map(caseIdFromReference)).size, 3);
  assert.equal(new Set(references.map(path => defaultActualPath(path, "ios"))).size, 3);
  assert.equal(fixtureIdFromReference(references[1]), "voice-control--auto-loop--frame-000--0000ms");
  assert.throws(() => caseIdFromReference("design/arbitrary/frame-000--0000ms.png"), /canonical handoff/);
});
