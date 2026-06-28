import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDownloadsHandler } from "./downloads.ts";

// Bun global is not present in vitest's Node worker threads. Stub it with a
// node:fs-backed implementation so Bun.file() calls in the handler work in tests
// while the real streaming Bun.file is used in production.
beforeAll(() => {
  vi.stubGlobal("Bun", {
    file: (path: string) => {
      // Build a Blob from the real file bytes so blob.size is correct and
      // new Response(blob) works as a BodyInit. Blob.size is readonly so we
      // cannot add our own size getter via Object.assign — the natural value is fine.
      const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
      const blob = new Blob([bytes]);
      return Object.assign(blob, {
        exists: async () => existsSync(path),
        json: async () => JSON.parse(readFileSync(path, "utf8")),
        text: async () => readFileSync(path, "utf8"),
      });
    },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dl-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ android: { versionCode: 7 } }));
  mkdirSync(join(dir, "android"), { recursive: true });
  writeFileSync(join(dir, "android", "latest.apk"), "APKBYTES");
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
    const dir = fixtureDir();
    mkdirSync(join(dir, "ios"), { recursive: true });
    const res = await handler(dir)(new Request("https://x/download/ios/manifest.plist"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toContain("application/xml");
  });

  it("serves /download/qr.png as image/png with max-age=3600", async () => {
    const res = await handler(fixtureDir())(new Request("https://x/download/qr.png"));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("cache-control")).toContain("max-age=3600");
  });
});
