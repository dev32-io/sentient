import assert from "node:assert/strict";
import test from "node:test";
import { runVisualDiff } from "./visual-diff.mjs";

function harness(result) {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    dependencies: {
      compare: async () => result,
      compositeImage: async () => {},
      measureVisiblePixels: async () => ({ visiblePixelCount: 2_400, canvasPixelCount: 5_000 }),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

test("rejects malformed invocation", async () => {
  const output = harness({ match: true });
  assert.equal(await runVisualDiff([], output.dependencies), 2);
  assert.match(output.stderr.join("\n"), /Expected exactly two image paths/);
});

test("rejects diff outputs that could overwrite an input", async () => {
  const output = harness({ match: true });
  const reference = "build/visual-captures/test/reference.png";
  assert.equal(
    await runVisualDiff([reference, "build/visual-captures/test/actual.png", "--diff", reference], output.dependencies),
    2,
  );
  assert.match(output.stderr.join("\n"), /must not overwrite/);
});

test("keeps pixel differences report-only without a reviewed gate", async () => {
  const output = harness({
    match: false,
    reason: "pixel-diff",
    diffCount: 12,
    diffPercentage: 0.5,
    diffLines: [2, 4],
    diffCols: [1, 8],
  });
  assert.equal(await runVisualDiff(["build/visual-captures/test/reference.png", "build/visual-captures/test/actual.png"], output.dependencies), 0);
  const report = JSON.parse(output.stdout[0]);
  assert.equal(report.diffPercentage, 0.5);
  assert.equal(report.canvasDiffPercentage, 0.5);
  assert.equal(report.percentageBasis, "visible-alpha-union");
  assert.equal(report.background, "#2B2621");
  assert.equal(report.threshold, 0.04);
  assert.equal(report.antialiasingIgnored, true);
  assert.deepEqual(report.bounds, { left: 1, top: 2, right: 8, bottom: 4 });
});

test("fails only when the visible-pixel percentage exceeds a configured gate", async () => {
  const output = harness({
    match: false,
    reason: "pixel-diff",
    diffCount: 20,
    diffPercentage: 0.4,
    diffLines: [1],
    diffCols: [1],
  });
  output.dependencies.measureVisiblePixels = async () => ({ visiblePixelCount: 1_000, canvasPixelCount: 5_000 });
  assert.equal(
    await runVisualDiff([
      "build/visual-captures/test/reference.png",
      "build/visual-captures/test/actual.png",
      "--max-diff-percentage",
      "1",
    ], output.dependencies),
    1,
  );
  assert.equal(JSON.parse(output.stdout[0]).withinLimit, false);
});
