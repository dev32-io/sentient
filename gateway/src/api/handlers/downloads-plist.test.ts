import { describe, expect, it } from "vitest";
import { renderItmsPlist } from "./downloads-plist.ts";

const MANIFEST = {
  ios: {
    bundleVersion: 3,
    shortVersion: "0.1.5",
    bundleId: "io.dev32.sentient",
    url: "/download/ios/latest.ipa",
  },
};

describe("renderItmsPlist", () => {
  it("emits a software-package asset with an absolute https ipa url", () => {
    const xml = renderItmsPlist(MANIFEST, "https://sentient.dev32.io");
    expect(xml).toContain("https://sentient.dev32.io/download/ios/latest.ipa");
    expect(xml).toContain("software-package");
  });

  it("embeds the bundle identifier and version", () => {
    const xml = renderItmsPlist(MANIFEST, "https://sentient.dev32.io");
    expect(xml).toContain("io.dev32.sentient");
    expect(xml).toContain("<string>0.1.5</string>");
  });

  it("emits display-image + full-size-image icon assets", () => {
    const xml = renderItmsPlist(MANIFEST, "https://sentient.dev32.io");
    expect(xml).toContain("https://sentient.dev32.io/download/ios/icon-57.png");
    expect(xml).toContain("https://sentient.dev32.io/download/ios/icon-512.png");
  });

  it("starts with the plist doctype", () => {
    expect(renderItmsPlist(MANIFEST, "https://x").startsWith("<?xml")).toBe(true);
  });
});
