import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compositePng, measureVisibleAlphaUnion, parseHexColor } from "./image-background.mjs";

test("parses reviewed opaque background colors", () => {
  assert.deepEqual(parseHexColor("#2B2621"), { red: 43, green: 38, blue: 33 });
  assert.throws(() => parseHexColor("transparent"), /six-digit hex/);
});

test("composites transparent PNG pixels on the selected background", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentient-background-"));
  const input = join(directory, "input.png");
  const output = join(directory, "output.png");
  const image = new PNG({ width: 1, height: 1 });
  image.data.set([255, 255, 255, 0]);
  await writeFile(input, PNG.sync.write(image));
  await compositePng(input, output, parseHexColor("#2B2621"));
  const rendered = PNG.sync.read(await readFile(output));
  assert.deepEqual([...rendered.data], [43, 38, 33, 255]);
});

test("measures the union of visible pixels without transparent canvas padding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sentient-visible-pixels-"));
  const referencePath = join(directory, "reference.png");
  const actualPath = join(directory, "actual.png");
  const reference = new PNG({ width: 3, height: 1 });
  const actual = new PNG({ width: 3, height: 1 });
  reference.data.set([
    255, 0, 0, 255,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  actual.data.set([
    255, 0, 0, 255,
    0, 255, 0, 128,
    0, 0, 0, 0,
  ]);
  await Promise.all([
    writeFile(referencePath, PNG.sync.write(reference)),
    writeFile(actualPath, PNG.sync.write(actual)),
  ]);
  assert.deepEqual(await measureVisibleAlphaUnion(referencePath, actualPath), {
    visiblePixelCount: 2,
    canvasPixelCount: 3,
  });
});
