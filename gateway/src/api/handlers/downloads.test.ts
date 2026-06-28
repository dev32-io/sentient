import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDownloadsHandler } from "./downloads.ts";

// Under `bun test`, the native Bun global (including Bun.file) is available.
// No stub needed — the handler's Bun.file calls work against the real temp-dir
// fixture files created below with node:fs.

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dl-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ android: { versionCode: 7 } }));
  mkdirSync(join(dir, "android"), { recursive: true });
  writeFileSync(join(dir, "android", "latest.apk"), "APKBYTES");
  return dir;
}

/** Fixture with a full manifest (android + ios blocks) for plist serving tests. */
function fixtureDirWithIos(): string {
  const dir = mkdtempSync(join(tmpdir(), "dl-ios-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      android: { versionCode: 7 },
      ios: {
        bundleVersion: 3,
        shortVersion: "0.1.5",
        bundleId: "io.test.app",
        url: "/download/ios/latest.ipa",
        manifestUrl: "/download/ios/manifest.plist",
      },
    }),
  );
  mkdirSync(join(dir, "android"), { recursive: true });
  writeFileSync(join(dir, "android", "latest.apk"), "APKBYTES");
  mkdirSync(join(dir, "ios"), { recursive: true });
  return dir;
}

function handler(dir: string) {
  return createDownloadsHandler({
    artifactsDir: dir,
    publicBaseUrl: "https://example.test",
    renderLandingPage: () => "<!doctype html><title>Get</title>",
    renderPlist: () => "<plist/>",
  });
}

describe("downloads handler", () => {
  it("returns null for non-/download paths", async () => {
    const res = await handler(fixtureDir())(new Request("https://x/api/v1/health"));
    expect(res).toBeNull();
  });

  it("serves the landing page at /download", async () => {
    const res = await handler(fixtureDir())(new Request("https://x/download"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("text/html");
  });

  it("serves manifest.json with no-cache", async () => {
    const res = await handler(fixtureDir())(new Request("https://x/download/manifest.json"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("application/json");
    expect(res?.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves the apk with the android package mime", async () => {
    const res = await handler(fixtureDir())(new Request("https://x/download/android/latest.apk"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("application/vnd.android.package-archive");
  });

  it("404s a missing artifact under /download", async () => {
    const res = await handler(fixtureDir())(new Request("https://x/download/android/nope.apk"));
    expect(res?.status).toBe(404);
  });

  it("rejects path traversal", async () => {
    // WHATWG URL normalises "/download/../config.yaml" to "/config.yaml" before the handler
    // sees it, so use percent-encoded slashes (%2F) — those survive normalisation and remain
    // a recognisable traversal attempt that the handler must reject.
    const res = await handler(fixtureDir())(new Request("https://x/download/..%2Fetc%2Fpasswd"));
    expect(res?.status).toBe(404);
  });

  it("serves the ios plist at /download/ios/manifest.plist", async () => {
    const res = await handler(fixtureDirWithIos())(new Request("https://x/download/ios/manifest.plist"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("application/xml");
  });

  it("404s /download/ios/manifest.plist when manifest has no ios block", async () => {
    // android-only manifest — servePlist must guard and return 404, not 500
    const res = await handler(fixtureDir())(new Request("https://x/download/ios/manifest.plist"));
    expect(res?.status).toBe(404);
  });

  it("serves /download/qr.png as image/png with max-age=3600", async () => {
    const res = await handler(fixtureDir())(new Request("https://x/download/qr.png"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("cache-control")).toContain("max-age=3600");
  });
});
