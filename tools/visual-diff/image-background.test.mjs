import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compositePng, parseHexColor } from "./image-background.mjs";

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
