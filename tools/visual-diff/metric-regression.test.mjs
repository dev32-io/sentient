import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { runVisualDiff } from "./visual-diff.mjs";

test("real ODiff rejects transparent substitution; web 0.56 still hides seeded color defects", async () => {
  const root = resolve("build/visual-captures/test");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "metric-"));
  try {
    const reference = join(directory, "reference.png");
    const actual = join(directory, "actual.png");
    const image = new PNG({ width: 100, height: 100 });
    const paint = async (path, rgba) => {
      for (let offset = 0; offset < image.data.length; offset += 4) image.data.set(rgba, offset);
      await writeFile(path, PNG.sync.write(image));
    };
    const compare = async (threshold, max) => {
      let report;
      const exit = await runVisualDiff([reference, actual, "--threshold", String(threshold), "--max-diff-percentage", String(max)], {
        stdout: line => { report = JSON.parse(line); },
      });
      return { report, exit };
    };
    await paint(reference, [43, 38, 33, 255]);
    await paint(actual, [43, 38, 33, 0]);
    const alpha = await compare(0.02, 4.25);
    assert.equal(alpha.exit, 1);
    assert.equal(alpha.report.diffCount, 0); // Dusk compositing alone loses alpha.
    assert.equal(alpha.report.shapeDiffPercentage, 100);
    await paint(reference, [0, 0, 0, 255]);
    await paint(actual, [147, 147, 147, 255]);
    const looseWeb = await compare(0.56, 0.2);
    assert.equal(looseWeb.report.diffCount, 0); // Demonstrated false pass, NOT validated parity.
    assert.equal(looseWeb.exit, 0);
    assert.equal((await compare(0.02, 4.25)).exit, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
