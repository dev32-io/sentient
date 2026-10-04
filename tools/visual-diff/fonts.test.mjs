import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { localFontCss } from "./capture-web.mjs";

test("web capture loads all nine original reference faces without native Fraunces", async () => {
  const nativeRoot = new URL("../../ios/App/Resources/Fonts/", import.meta.url);
  const nativeFiles = [
    "DMSans-Bold.ttf", "DMSans-Medium.ttf", "DMSans-Regular.ttf", "DMSans-SemiBold.ttf",
    "JetBrainsMono-Medium.ttf", "JetBrainsMono-Regular.ttf",
  ];
  assert.deepEqual((await readdir(nativeRoot)).sort(), nativeFiles);
  const originalFraunces = {
    "Fraunces-Medium.ttf": "9267e67d2ed2cda2c197c89c7fbc484cde4382326bda5e6f36f64a92d1f6413e",
    "Fraunces-Regular.ttf": "ec4f77601c0e13d5ae3109552ddeab6d7c8845bf60d59619248812bd2231a314",
    "Fraunces-SemiBold.ttf": "0f897fb1bea230ae78a90f97bb025c3ca34d3039b3be7f7b1ceb00912ec9f59c",
  };
  const css = await localFontCss();
  assert.equal((css.match(/@font-face/g) ?? []).length, 9);
  for (const file of nativeFiles) {
    const bytes = await readFile(new URL(file, nativeRoot));
    assert.ok(css.includes(bytes.toString("base64")), file);
  }
  for (const [file, hash] of Object.entries(originalFraunces)) {
    const bytes = await readFile(new URL(`fonts/${file}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, file);
    assert.ok(css.includes(bytes.toString("base64")), file);
  }
  for (const weight of [400, 500, 600]) assert.ok(css.includes(`font-family:"Fraunces";font-style:normal;font-weight:${weight};`));
});
