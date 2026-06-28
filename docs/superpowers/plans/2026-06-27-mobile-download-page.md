# Mobile Download Page + In-App OTA Auto-Update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve mobile apps from the gateway at a public `/download` path (page + artifacts + OTA-ready manifest), add an in-app one-tap OTA auto-updater to both mobile clients, fix the web settings page on narrow mobile viewports, and bump the forgotten mobile version.

**Architecture:** Phase A adds a public, pre-auth `/download/*` route group in the Bun gateway that serves a server-rendered landing page, the apk/ipa artifacts from a mounted release dir, a `manifest.json` version feed, and an on-the-fly iOS `itms-services` plist. Phase B adds a shared KMP `update` core (fetch manifest unauthenticated, compare monotonic build numbers, decide optional-vs-mandatory) plus thin per-platform install triggers (Android `PackageInstaller`, iOS outbound `itms-services` open) and the OTA UI (settings check, optional-update banner, mandatory force-update gate, foreground-triggered check).

**Tech Stack:** Bun + TypeScript + zod (gateway), Preact + plain CSS (webui), Kotlin Multiplatform + Ktor + kotlinx.serialization (shared SDK), Jetpack Compose (Android), SwiftUI (iOS), bash + xcodegen + gradle (build/deploy).

## Global Constraints

- **Branch:** `feature/mobile-download-page` (already created off latest `develop`).
- **Transport is HTTPS-only.** Gateway serves `/download` + artifacts over `443` (also `8888`); there is NO `:80` listener and NO HTTP→HTTPS redirect. (docker-compose maps `443:8888`.)
- **`/download/*` is PUBLIC** — registered before the auth gate and before the SPA static fallback. No PASETO session required. The OTA manifest check is unauthenticated (self-heal for expired-token builds).
- **Files <300 lines, split at 250. Functions <40 lines, extract at 30. Max nest depth 3.** (clean-code rule.)
- **No magic numbers/strings** — gateway tunables live in `gateway/config.yaml` with inline comments; protocol strings / status codes stay as code constants.
- **Tagged loggers everywhere, no bare console/print.** Gateway: `getLog([...])`. Webui: `createLogger([...])` from `@sentient/web-sdk`. Mobile: `createLogger(...)` from `io.sentient.mobilesdk.log`. NEVER log user/chat content; OTA logs carry versions/ids/status only.
- **commonMain purity:** no `android.*` / `platform.*` / `java.*` in commonMain. Platform capability enters via `expect`/`actual` or an injected interface. No `System.currentTimeMillis()`/`Date()` in commonMain — inject. (mobile-sdk rules.)
- **Wire contract is exact:** the KMP `UpdateManifest` serializable mirrors the server `manifest.json` field names verbatim (web-sdk-mirror-contract).
- **Version comparison uses the monotonic build number** — Android `versionCode` (int), iOS `CFBundleVersion` (int). Never semver.
- **Test bar (test-lean doctrine):** unit-test ONLY wire/protocol contracts, FSM/invariants, security boundaries. Do NOT unit-test CSS, copy, DI/config plumbing, pure UI, version constants. E2E/smoke (Playwright web / Maestro native) covers the rest — owned by the agent.
- **Version bump target:** Android `versionCode 6→7` / `versionName 0.1.4→0.1.5`; iOS `CFBundleShortVersionString 0.1.4→0.1.5` / `CFBundleVersion 2→3` (regenerate `Info.plist` via xcodegen — never hand-edit it).
- **iOS install is ad-hoc** → installs only on UDID-registered devices; the page + OTA say "registered devices only."

---

# Phase A — Server foundation (gateway + webui + deploy + version bump)

## Task A1: Add the `downloads` config section

**Files:**
- Modify: `shared/config/src/schema.ts` (add `downloads` to the gateway config zod schema + exported type)
- Modify: `gateway/config.yaml` (add the `downloads:` section)
- Modify: `gateway/src/bootstrap/create-gateway-services.ts` (expose `downloads` config on `GatewayServices`)
- Test: `shared/config/src/schema.test.ts` (one case: the new section parses)

**Interfaces:**
- Produces: `GatewayConfig["downloads"] = { artifacts_dir: string; public_base_url: string }`; `GatewayServices.downloads: { artifactsDir: string; publicBaseUrl: string }`.

- [ ] **Step 1: Inspect the existing schema shape.** Read `shared/config/src/schema.ts` and find the `webui:` block in the zod object + how a section is declared (e.g. `z.object({...})`). Match that style.

- [ ] **Step 2: Write the failing schema test.** In `shared/config/src/schema.test.ts`, add:

```ts
it("parses the downloads section", () => {
  const yaml = `
schema_version: "0.1.1"
downloads:
  artifacts_dir: /app/releases
  public_base_url: https://sentient.dev32.io
`;
  // reuse whatever minimal-yaml helper the other tests use; if they parse a full
  // fixture, extend that fixture instead and assert the downloads fields.
  const cfg = loadConfig(yaml, gatewayConfigSchema); // adapt to the test's existing import
  expect(cfg.downloads.artifacts_dir).toBe("/app/releases");
  expect(cfg.downloads.public_base_url).toBe("https://sentient.dev32.io");
});
```

- [ ] **Step 3: Run it, expect failure.** Run: `source scripts/env.sh && cd shared/config && bun run test` → FAIL (`downloads` undefined / schema rejects unknown key).

- [ ] **Step 4: Add the schema.** In `shared/config/src/schema.ts`, add to the gateway config object (alongside `webui`):

```ts
downloads: z.object({
  // Container path to the mounted release dir holding apk/ipa/manifest.json.
  artifacts_dir: z.string(),
  // Absolute HTTPS origin used to build itms-services plist URLs (must be HTTPS).
  public_base_url: z.string().url(),
}),
```

- [ ] **Step 5: Add the YAML.** In `gateway/config.yaml`, after the `webui:` block (~line 177), add:

```yaml
# ---------------------------------------------------------------------------
# Downloads — public /download page + mobile artifact serving (OTA root)
# ---------------------------------------------------------------------------
downloads:
  # Container path to the mounted host release dir (apk/ipa/manifest.json/icons).
  # Mounted read-only from ~/.sentient/releases via docker-compose. See Task A6.
  artifacts_dir: /app/releases
  # Absolute HTTPS origin. iOS itms-services plist REQUIRES absolute HTTPS URLs.
  public_base_url: https://sentient.dev32.io
```

- [ ] **Step 6: Thread to services.** In `gateway/src/bootstrap/create-gateway-services.ts`, add to the `GatewayServices` interface (near `webDistDir`, ~line 97):

```ts
  readonly downloads: { artifactsDir: string; publicBaseUrl: string };
```

and in the object the factory returns (near `webDistDir: cfg.webDistDir`, ~line 205):

```ts
    downloads: {
      artifactsDir: config.downloads.artifacts_dir,
      publicBaseUrl: config.downloads.public_base_url,
    },
```

Read the file first to confirm the exact local name of the parsed config (it may be `config` or `cfg`) and mirror it.

- [ ] **Step 7: Run the test, expect pass.** Run: `source scripts/env.sh && cd shared/config && bun run test` → PASS.

- [ ] **Step 8: Commit.**

```bash
git add shared/config/src/schema.ts shared/config/src/schema.test.ts gateway/config.yaml gateway/src/bootstrap/create-gateway-services.ts
git commit -m "feat(gateway): add downloads config section (artifacts_dir + public_base_url)"
```

---

## Task A2: Downloads handler — manifest + artifact serving + 404

**Files:**
- Create: `gateway/src/api/handlers/downloads.ts`
- Test: `gateway/src/api/handlers/downloads.test.ts`

**Interfaces:**
- Consumes: `GatewayServices.downloads` (from A1).
- Produces: `createDownloadsHandler(deps: DownloadsHandlerDeps): DownloadsHandler` where
  `DownloadsHandlerDeps = { artifactsDir: string; publicBaseUrl: string; renderLandingPage: () => string; renderPlist: (m: unknown) => string }`
  and `DownloadsHandler = (request: Request) => Promise<Response | null>` — returns `null` when the path is not under `/download` (so the router falls through).
- Route table (all GET):
  - `/download` → landing page HTML (A4 injects `renderLandingPage`)
  - `/download/manifest.json` → the on-disk `manifest.json` (`application/json`, `no-cache`)
  - `/download/ios/manifest.plist` → generated plist (A3 injects `renderPlist`)
  - `/download/android/latest.apk` → apk (`application/vnd.android.package-archive`)
  - `/download/ios/latest.ipa` → ipa (`application/octet-stream`)
  - `/download/ios/icon-57.png`, `/download/ios/icon-512.png` → png passthrough
  - anything else under `/download/` → 404

- [ ] **Step 1: Write failing tests.** Create `gateway/src/api/handlers/downloads.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDownloadsHandler } from "./downloads.ts";

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dl-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ android: { versionCode: 7 } }));
  writeFileSync(join(dir, "android", "latest.apk"), "APKBYTES"); // mkdir first in real impl
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
    const res = await handler(fixtureDir())(new Request("https://x/download/../config.yaml"));
    expect(res?.status).toBe(404);
  });
});
```

(Adjust the fixture to `mkdirSync(join(dir,"android"),{recursive:true})` before writing the apk.)

- [ ] **Step 2: Run, expect failure.** Run: `source scripts/env.sh && cd gateway && bunx vitest run src/api/handlers/downloads.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the handler.** Create `gateway/src/api/handlers/downloads.ts`:

```ts
import { join } from "node:path";
import { getLog } from "../../logging/logger.ts";

const log = getLog(["sentient", "api", "downloads"]);

const HTTP_NOT_FOUND = 404;
const PREFIX = "/download";
const NO_CACHE = "no-cache";

// path under /download -> { file relative to artifactsDir, content-type }
const ARTIFACT_ROUTES: Record<string, { file: string; mime: string }> = {
  "/download/manifest.json": { file: "manifest.json", mime: "application/json" },
  "/download/android/latest.apk": {
    file: "android/latest.apk",
    mime: "application/vnd.android.package-archive",
  },
  "/download/ios/latest.ipa": { file: "ios/latest.ipa", mime: "application/octet-stream" },
  "/download/ios/icon-57.png": { file: "ios/icon-57.png", mime: "image/png" },
  "/download/ios/icon-512.png": { file: "ios/icon-512.png", mime: "image/png" },
};

export interface DownloadsHandlerDeps {
  artifactsDir: string;
  publicBaseUrl: string;
  renderLandingPage: () => string;
  renderPlist: (manifest: unknown) => string;
}

export type DownloadsHandler = (request: Request) => Promise<Response | null>;

export function createDownloadsHandler(deps: DownloadsHandlerDeps): DownloadsHandler {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;
    if (request.url.includes("..")) return notFound(pathname);

    if (pathname === PREFIX) return html(deps.renderLandingPage());
    if (pathname === "/download/ios/manifest.plist") return servePlist(deps);

    const route = ARTIFACT_ROUTES[pathname];
    if (!route) return notFound(pathname);
    return serveFile(join(deps.artifactsDir, route.file), route.mime, pathname);
  };
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_CACHE },
  });
}

async function servePlist(deps: DownloadsHandlerDeps): Promise<Response> {
  const manifestFile = Bun.file(join(deps.artifactsDir, "manifest.json"));
  if (!(await manifestFile.exists())) return notFound("/download/ios/manifest.plist");
  const manifest = await manifestFile.json();
  return new Response(deps.renderPlist(manifest), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": NO_CACHE },
  });
}

async function serveFile(path: string, mime: string, pathname: string): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return notFound(pathname);
  const size = file.size;
  log.info("artifact-serve", { path: pathname, bytes: size, mime });
  return new Response(file, { headers: { "Content-Type": mime, "Cache-Control": NO_CACHE } });
}

function notFound(pathname: string): Response {
  log.warn("artifact-missing", { reason: "missing", path: pathname });
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}
```

- [ ] **Step 4: Run, expect pass.** Run: `source scripts/env.sh && cd gateway && bunx vitest run src/api/handlers/downloads.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add gateway/src/api/handlers/downloads.ts gateway/src/api/handlers/downloads.test.ts
git commit -m "feat(gateway): downloads handler — manifest + artifact serving + 404"
```

---

## Task A3: iOS itms-services plist generation

**Files:**
- Create: `gateway/src/api/handlers/downloads-plist.ts`
- Test: `gateway/src/api/handlers/downloads-plist.test.ts`

**Interfaces:**
- Produces: `renderItmsPlist(manifest: unknown, publicBaseUrl: string): string` — consumed by A2's `renderPlist` (bound with `publicBaseUrl` in server.ts, A5).
- Reads from the manifest's `ios` block: `bundleVersion:number`, `shortVersion:string`, `bundleId:string`, `url:string` (relative ipa path), and resolves all asset URLs absolute against `publicBaseUrl`.

- [ ] **Step 1: Write failing tests.** Create `gateway/src/api/handlers/downloads-plist.test.ts`:

```ts
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
```

- [ ] **Step 2: Run, expect failure.** Run: `source scripts/env.sh && cd gateway && bunx vitest run src/api/handlers/downloads-plist.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Create `gateway/src/api/handlers/downloads-plist.ts`:

```ts
interface IosBlock {
  bundleVersion: number;
  shortVersion: string;
  bundleId: string;
  url: string;
}

const ICON_57 = "/download/ios/icon-57.png";
const ICON_512 = "/download/ios/icon-512.png";

/** Builds an itms-services manifest.plist from the release manifest.
 *  All asset URLs are absolute HTTPS (itms-services requires it). */
export function renderItmsPlist(manifest: unknown, publicBaseUrl: string): string {
  const ios = (manifest as { ios: IosBlock }).ios;
  const base = publicBaseUrl.replace(/\/$/, "");
  const abs = (p: string): string => `${base}${p}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array>
<dict><key>kind</key><string>software-package</string><key>url</key><string>${abs(ios.url)}</string></dict>
<dict><key>kind</key><string>display-image</string><key>url</key><string>${abs(ICON_57)}</string></dict>
<dict><key>kind</key><string>full-size-image</string><key>url</key><string>${abs(ICON_512)}</string></dict>
</array>
<key>metadata</key><dict>
<key>bundle-identifier</key><string>${ios.bundleId}</string>
<key>bundle-version</key><string>${ios.shortVersion}</string>
<key>kind</key><string>software</string>
<key>title</key><string>Sentient</string>
</dict></dict></array></dict></plist>`;
}
```

- [ ] **Step 4: Run, expect pass.** Run: `source scripts/env.sh && cd gateway && bunx vitest run src/api/handlers/downloads-plist.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add gateway/src/api/handlers/downloads-plist.ts gateway/src/api/handlers/downloads-plist.test.ts
git commit -m "feat(gateway): generate itms-services plist from release manifest"
```

---

## Task A4: `/download` landing page (server-rendered, mobile-first)

**Files:**
- Create: `gateway/src/api/handlers/downloads-page.ts`

**Interfaces:**
- Produces: `renderDownloadPage(publicBaseUrl: string): string` — consumed by A2's `renderLandingPage` (bound with `publicBaseUrl` in A5). Pure string; no per-request data (version is fetched client-side from `/download/manifest.json` so the page itself stays static + cacheable-free).

No unit test (HTML/copy; covered by Playwright smoke in the E2E matrix).

- [ ] **Step 1: Implement.** Create `gateway/src/api/handlers/downloads-page.ts`. Self-contained HTML + inline CSS (own minimal styles — the page is standalone, not the SPA). Mobile-first single column, tap targets ≥44px. Fetches the manifest client-side to show version; iOS button builds the itms-services URL:

```ts
const ITMS = (base: string): string =>
  `itms-services://?action=download-manifest&amp;url=${base}/download/ios/manifest.plist`;

/** Standalone, pre-auth, mobile-first download/install page. Version is filled
 *  client-side from /download/manifest.json so this string stays data-free. */
export function renderDownloadPage(publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/$/, "");
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Get Sentient</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#0f1115;color:#f3f5f8;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  main{width:100%;max-width:420px;text-align:center}
  h1{font-size:1.6rem;margin:0 0 4px}
  p.sub{color:#9aa3af;margin:0 0 28px}
  a.btn{display:flex;align-items:center;justify-content:center;min-height:52px;margin:12px 0;
    border-radius:14px;text-decoration:none;font-weight:600;font-size:1.05rem}
  a.android{background:#3ddc84;color:#08130c}
  a.ios{background:#0a84ff;color:#fff}
  .note{color:#9aa3af;font-size:.85rem;margin-top:6px}
  .ver{color:#6b7280;font-size:.8rem;margin-top:28px}
</style></head><body><main>
  <h1>Get Sentient</h1>
  <p class="sub">Install the family assistant app.</p>
  <a class="btn android" href="${base}/download/android/latest.apk">Download for Android (APK)</a>
  <a class="btn ios" href="${ITMS(base)}">Install on iPhone</a>
  <p class="note">iPhone install works on registered devices only (ad-hoc provisioning).</p>
  <p class="ver" id="ver"></p>
  <script>
    fetch("/download/manifest.json").then(function(r){return r.json()}).then(function(m){
      var a=m&&m.android,i=m&&m.ios;
      document.getElementById("ver").textContent=
        "Android "+(a?a.versionName:"?")+" · iOS "+(i?i.shortVersion:"?");
    }).catch(function(){});
  </script>
</main></body></html>`;
}
```

- [ ] **Step 2: Verify it builds (typecheck).** Run: `source scripts/env.sh && cd gateway && bun run typecheck` → no errors.

- [ ] **Step 3: Commit.**

```bash
git add gateway/src/api/handlers/downloads-page.ts
git commit -m "feat(gateway): server-rendered mobile-first /download landing page"
```

---

## Task A5: Wire the downloads handler into the router (before auth + static)

**Files:**
- Modify: `gateway/src/api/router.ts` (add `handleDownloads` dep + dispatch first)
- Modify: `gateway/src/server.ts` (construct the handler, pass into router)

**Interfaces:**
- Consumes: A2 `createDownloadsHandler`, A3 `renderItmsPlist`, A4 `renderDownloadPage`, A1 `services.downloads`.
- The router calls `handleDownloads` FIRST; if it returns a `Response`, return it; if `null`, fall through to the existing API/static routing.

- [ ] **Step 1: Add the router dep + dispatch.** In `gateway/src/api/router.ts`, add to `ApiRouterDeps`:

```ts
  /** Serves the public /download/* page + artifacts. Returns null when the
   *  path is not under /download so normal routing proceeds. Public — no gate. */
  handleDownloads: (request: Request) => Promise<Response | null>;
```

and at the TOP of the returned router function (before the `${API_V1}` checks, ~line 50):

```ts
    const downloadResponse = await deps.handleDownloads(request);
    if (downloadResponse) return downloadResponse;
```

- [ ] **Step 2: Construct the handler in server.ts.** In `gateway/src/server.ts`, near `const handleStatic = createWebuiHandler(...)` (~line 128), add imports at top:

```ts
import { createDownloadsHandler } from "./api/handlers/downloads.ts";
import { renderItmsPlist } from "./api/handlers/downloads-plist.ts";
import { renderDownloadPage } from "./api/handlers/downloads-page.ts";
```

and the handler:

```ts
  const handleDownloads = createDownloadsHandler({
    artifactsDir: services.downloads.artifactsDir,
    publicBaseUrl: services.downloads.publicBaseUrl,
    renderLandingPage: () => renderDownloadPage(services.downloads.publicBaseUrl),
    renderPlist: (manifest) => renderItmsPlist(manifest, services.downloads.publicBaseUrl),
  });
```

- [ ] **Step 3: Pass into the router.** In the `createApiRouter({...})` call (~line 157), add `handleDownloads,` to the deps object.

- [ ] **Step 4: Typecheck.** Run: `source scripts/env.sh && cd gateway && bun run typecheck` → no errors.

- [ ] **Step 5: Smoke locally (real stack).** Boot the local stack and verify the route is live and pre-auth:

```bash
source scripts/env.sh
docker compose -f deploy/macos/docker-compose.yml up -d --build gateway
# create the release dir + a manifest so the page renders
mkdir -p ~/.sentient/releases/android ~/.sentient/releases/ios
echo '{"android":{"versionCode":7,"versionName":"0.1.5","minSupportedBuild":0,"url":"/download/android/latest.apk","notes":""},"ios":{"bundleVersion":3,"shortVersion":"0.1.5","minSupportedBuild":0,"bundleId":"io.dev32.sentient","url":"/download/ios/latest.ipa","manifestUrl":"/download/ios/manifest.plist","notes":""}}' > ~/.sentient/releases/manifest.json
curl -ks https://localhost:8888/download | grep -i "Get Sentient"
curl -ks https://localhost:8888/download/manifest.json | grep -i "0.1.5"
curl -ks https://localhost:8888/download/ios/manifest.plist | grep -i "software-package"
```

Expected: page HTML, manifest JSON, and plist all return. (Note: the local `deploy/macos/` mount must also map the release dir — see Task A6 step for the macos compose; for this smoke you can instead set `downloads.artifacts_dir` to a path already mounted, or add the mount.)

- [ ] **Step 6: Commit.**

```bash
git add gateway/src/api/router.ts gateway/src/server.ts
git commit -m "feat(gateway): mount public /download route before auth gate + static"
```

---

## Task A6: Deploy plumbing — mount release dir + retarget deploy script + manifest writing

**Files:**
- Modify: `deploy/mac-prod/docker-compose.yml` (mount `~/.sentient/releases` read-only)
- Modify: `deploy/macos/docker-compose.yml` (same mount, for local smoke — read it first to match its volume style)
- Modify: `scripts/deploy-mobile.sh` (scp to the mac mini release dir + write/update manifest.json)
- Modify: `scripts/build-android.sh` + `scripts/build-ios.sh` (pass version metadata to deploy)
- Modify: `scripts/release.local.conf.example` (new vars; read it first)

**Interfaces:**
- Produces the on-disk layout the handler (A2) reads: `<releases>/android/latest.apk`, `<releases>/ios/latest.ipa`, `<releases>/manifest.json`, plus `<releases>/ios/icon-57.png` + `icon-512.png` (added once, manually, from the app icon assets).

No unit test (shell/deploy; verified by the A5 smoke + a manual deploy dry-run).

- [ ] **Step 1: Add the mount (prod).** In `deploy/mac-prod/docker-compose.yml`, under the gateway `volumes:` list (~line 105), add:

```yaml
      # Mobile release artifacts (apk/ipa/manifest.json/icons) served at /download.
      # Read-only — the gateway only serves them; deploy-mobile.sh writes the host dir.
      - ${HOME}/.sentient/releases:/app/releases:ro
```

- [ ] **Step 2: Add the mount (local macos).** Read `deploy/macos/docker-compose.yml`, find the gateway `volumes:` block, add the same line (without `:ro` is fine locally, but keep `:ro` for parity). This makes the A5 smoke + native-against-local OTA work.

- [ ] **Step 3: Rewrite deploy-mobile.sh.** Replace `scripts/deploy-mobile.sh` so it (a) scp's the artifact into a per-platform path under the mac-mini release dir, (b) regenerates `manifest.json` from passed-in version metadata, (c) verifies by md5. New required `release.local.conf` vars: `DEPLOY_HOST`, `DEPLOY_USER`, `RELEASES_PATH` (e.g. `~/.sentient/releases`). The build scripts pass version via env. Concrete:

```bash
#!/usr/bin/env bash
# Deploy a mobile artifact to the Mac mini release dir served at /download, and
# refresh manifest.json. Version metadata comes from the calling build script
# via env (ANDROID_VERSION_CODE/NAME or IOS_BUNDLE_VERSION/SHORT_VERSION).
set -euo pipefail
ARTIFACT="${1:?usage: deploy-mobile.sh <path-to-.ipa-or-.apk>}"
[ -f "$ARTIFACT" ] || { echo "ERROR: artifact not found: $ARTIFACT"; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$DIR/release.local.conf"
[ -f "$CONF" ] || { echo "ERROR: $CONF missing — copy scripts/release.local.conf.example."; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
: "${DEPLOY_HOST:?set DEPLOY_HOST}" "${DEPLOY_USER:?set DEPLOY_USER}" "${RELEASES_PATH:?set RELEASES_PATH}"
: "${IOS_BUNDLE_ID:=io.dev32.sentient}" "${IOS_MIN_BUILD:=0}" "${ANDROID_MIN_BUILD:=0}"
SSH="ssh -o ConnectTimeout=10 ${DEPLOY_USER}@${DEPLOY_HOST}"

case "$ARTIFACT" in
  *.apk) PLAT=android; REMOTE="${RELEASES_PATH}/android/latest.apk" ;;
  *.ipa) PLAT=ios;     REMOTE="${RELEASES_PATH}/ios/latest.ipa" ;;
  *) echo "ERROR: unknown artifact type (expect .ipa/.apk): $ARTIFACT"; exit 1 ;;
esac

$SSH "mkdir -p ${RELEASES_PATH}/android ${RELEASES_PATH}/ios"
scp -o ConnectTimeout=10 "$ARTIFACT" "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE}"
LOCAL_MD5="$(md5 -q "$ARTIFACT" 2>/dev/null || md5sum "$ARTIFACT" | cut -d' ' -f1)"
REMOTE_MD5="$($SSH "md5sum '${REMOTE}'" | cut -d' ' -f1)"
[ "$LOCAL_MD5" = "$REMOTE_MD5" ] || { echo "✗ md5 mismatch"; exit 1; }
echo "✓ uploaded ${REMOTE} (md5 ${LOCAL_MD5})"

# --- regenerate manifest.json from the two latest deployed versions ---
# Read the existing remote manifest (if any) so the OTHER platform's block is
# preserved when only one platform is being deployed.
EXISTING="$($SSH "cat '${RELEASES_PATH}/manifest.json' 2>/dev/null || echo '{}'")"
MANIFEST="$(PLAT="$PLAT" EXISTING="$EXISTING" \
  ANDROID_VERSION_CODE="${ANDROID_VERSION_CODE:-}" ANDROID_VERSION_NAME="${ANDROID_VERSION_NAME:-}" \
  ANDROID_MIN_BUILD="$ANDROID_MIN_BUILD" \
  IOS_BUNDLE_VERSION="${IOS_BUNDLE_VERSION:-}" IOS_SHORT_VERSION="${IOS_SHORT_VERSION:-}" \
  IOS_MIN_BUILD="$IOS_MIN_BUILD" IOS_BUNDLE_ID="$IOS_BUNDLE_ID" \
  node "$DIR/build-manifest.mjs")"
echo "$MANIFEST" | $SSH "cat > '${RELEASES_PATH}/manifest.json'"
echo "✓ manifest.json updated"
```

- [ ] **Step 4: Add the manifest builder.** Create `scripts/build-manifest.mjs` (a tiny Node script that merges the deployed platform's block into the existing manifest and prints JSON). Keep it dependency-free:

```js
// Merge the just-deployed platform block into the existing manifest JSON.
// Inputs via env (see deploy-mobile.sh). Prints the merged manifest to stdout.
const prev = JSON.parse(process.env.EXISTING || "{}");
const plat = process.env.PLAT;
if (plat === "android") {
  prev.android = {
    versionCode: Number(process.env.ANDROID_VERSION_CODE),
    versionName: process.env.ANDROID_VERSION_NAME,
    minSupportedBuild: Number(process.env.ANDROID_MIN_BUILD || 0),
    url: "/download/android/latest.apk",
    notes: "",
  };
} else if (plat === "ios") {
  prev.ios = {
    bundleVersion: Number(process.env.IOS_BUNDLE_VERSION),
    shortVersion: process.env.IOS_SHORT_VERSION,
    minSupportedBuild: Number(process.env.IOS_MIN_BUILD || 0),
    bundleId: process.env.IOS_BUNDLE_ID,
    url: "/download/ios/latest.ipa",
    manifestUrl: "/download/ios/manifest.plist",
    notes: "",
  };
}
process.stdout.write(JSON.stringify(prev, null, 2));
```

- [ ] **Step 5: Pass versions from the build scripts.** In `scripts/build-android.sh`, before the deploy call (line 20), export the version read from gradle:

```bash
if [ "$DEPLOY" = "1" ]; then
  ANDROID_VERSION_CODE="$(cd "$REPO" && ./gradlew -q :android:printVersionCode 2>/dev/null || grep -oE 'versionCode = [0-9]+' android/build.gradle.kts | grep -oE '[0-9]+')"
  ANDROID_VERSION_NAME="$(grep -oE 'versionName = "[^"]+"' "$REPO/android/build.gradle.kts" | sed -E 's/.*"([^"]+)"/\1/')"
  export ANDROID_VERSION_CODE ANDROID_VERSION_NAME
  "$REPO/scripts/deploy-mobile.sh" "$APK"
fi
```

(Simplest: the `grep -oE` fallbacks above avoid needing a new gradle task.) In `scripts/build-ios.sh`, before the deploy call (line 27):

```bash
if [ "$DEPLOY" = "1" ]; then
  IOS_SHORT_VERSION="$(grep -E 'CFBundleShortVersionString:' "$REPO/ios/project.yml" | head -1 | sed -E 's/.*: *//')"
  IOS_BUNDLE_VERSION="$(grep -E 'CFBundleVersion:' "$REPO/ios/project.yml" | head -1 | sed -E 's/.*"?([0-9]+)"?.*/\1/')"
  export IOS_SHORT_VERSION IOS_BUNDLE_VERSION
  "$REPO/scripts/deploy-mobile.sh" "$IPA"
fi
```

- [ ] **Step 6: Update the example conf.** In `scripts/release.local.conf.example`, replace the old fileserver vars with `DEPLOY_HOST`, `DEPLOY_USER`, `RELEASES_PATH=~/.sentient/releases` (keep `IOS_TEAM_ID`/`APPLE_ID`). Read the file first; preserve unrelated vars + comments.

- [ ] **Step 7: Lint the shell.** Run: `shellcheck scripts/deploy-mobile.sh scripts/build-android.sh scripts/build-ios.sh` → no errors (or only pre-existing).

- [ ] **Step 8: Commit.**

```bash
git add deploy/mac-prod/docker-compose.yml deploy/macos/docker-compose.yml scripts/deploy-mobile.sh scripts/build-manifest.mjs scripts/build-android.sh scripts/build-ios.sh scripts/release.local.conf.example
git commit -m "feat(deploy): serve mobile artifacts from gateway release dir + manifest"
```

> **Manual one-time:** add `~/.sentient/releases/ios/icon-57.png` + `icon-512.png` (from the app icon) on the mac mini, for the itms display images. Flag in handover.

---

## Task A7: webui "Get the app" settings entry

**Files:**
- Create: `gateway/webui/src/components/settings/panes/get-app-pane.tsx`
- Modify: `gateway/webui/src/components/settings/sidebar/nav-config.ts` (add `getApp` key + nav item)
- Modify: `gateway/webui/src/components/settings/settings-view.tsx` (import + render the pane)
- Modify: `gateway/webui/src/components/settings/panes/panes.css` (a few styles for the pane)

**Interfaces:**
- Consumes: existing `Card`, `PaneHead`, `Btn` primitives + the existing `QrLinkModal` pattern (reuse the QR lib it uses — read `qr-link-modal.tsx` to find the QR component/import).

No unit test (UI/copy; Playwright smoke).

- [ ] **Step 1: Add the nav key + item.** In `nav-config.ts`: add `"getApp"` to the `SidebarKey` union, and a nav item to the `User` group:

```ts
      { key: "getApp", label: "Get the app", icon: "phone" },
```

(`getApp` is NOT added to `SOUL_KEYS` or `APPLY_BAR_KEYS` — no apply bar.)

- [ ] **Step 2: Create the pane.** Create `get-app-pane.tsx`:

```tsx
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Btn } from "../primitives/btn.tsx";

const log = createLogger(["sentient", "webui", "settings", "get-app-pane"]);
const DOWNLOAD_PATH = "/download";

export function GetAppPane(): JSX.Element {
  const url = `${location.origin}${DOWNLOAD_PATH}`;
  return (
    <>
      <PaneHead title="Get the app" sub="Install Sentient on your phone." />
      <Card title="Mobile apps" sub="Open the download page on your phone, or scan the code.">
        <p class="get-app-desc">
          Android installs the APK directly. iPhone installs over-the-air on
          registered devices (ad-hoc provisioning).
        </p>
        <div class="get-app-actions">
          <Btn
            kind="primary"
            size="sm"
            onClick={() => {
              log.info("open-download-page");
              window.open(DOWNLOAD_PATH, "_blank", "noopener");
            }}
          >
            Open download page
          </Btn>
        </div>
        <div class="get-app-qr">{/* QR of `url` — reuse the QR component from qr-link-modal.tsx */}</div>
        <code class="get-app-url">{url}</code>
      </Card>
    </>
  );
}
```

(For the QR: read `qr-link-modal.tsx`, find the QR render component/lib it imports, and render `url` with it inside `.get-app-qr`.)

- [ ] **Step 3: Render in settings-view.** In `settings-view.tsx`: import `GetAppPane`, and add a render branch alongside the others (e.g. after `devices`):

```tsx
          {tab === "getApp" && <GetAppPane />}
```

- [ ] **Step 4: Style.** In `panes.css`, add minimal styles for `.get-app-desc`, `.get-app-actions`, `.get-app-qr`, `.get-app-url` (match the namespaced `.settings-v2` patterns in the file).

- [ ] **Step 5: Typecheck + lint.** Run: `source scripts/env.sh && cd gateway/webui && bun run typecheck && bun run lint` → clean.

- [ ] **Step 6: Commit.**

```bash
git add gateway/webui/src/components/settings/panes/get-app-pane.tsx gateway/webui/src/components/settings/sidebar/nav-config.ts gateway/webui/src/components/settings/settings-view.tsx gateway/webui/src/components/settings/panes/panes.css
git commit -m "feat(webui): add 'Get the app' settings pane linking to /download"
```

---

## Task A8: Settings mobile-viewport fix (sidebar → top tab strip)

**Files:**
- Modify: `gateway/webui/src/components/settings/settings-shell.css`
- Modify: `gateway/webui/src/components/settings/sidebar/sidebar.css`

**Interfaces:** none (CSS only). At `≤880px` the existing grid already collapses to one column; this task makes the nav usable: `.s-nav` becomes a horizontal scrollable strip, group headers hide, items shrink to chips.

No unit test (CSS; Playwright smoke at 390×844).

- [ ] **Step 1: Make the sidebar a horizontal strip at ≤880px.** In `settings-shell.css`, extend the existing `@media (max-width: 880px)` block:

```css
@media (max-width: 880px) {
  .settings-v2 { grid-template-columns: 1fr; }
  .settings-v2 .s-side {
    border-right: 0;
    border-bottom: 1px solid var(--color-line-soft);
    /* keep the strip pinned + scrollable on narrow screens */
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--color-bg);
  }
  .settings-v2 .s-main { padding: 20px 16px 140px; }
}
```

- [ ] **Step 2: Reflow the nav at ≤880px.** In `sidebar.css`, append:

```css
@media (max-width: 880px) {
  .settings-v2 .s-nav {
    flex-direction: row;
    flex-wrap: nowrap;
    gap: 6px;
    padding: 10px 12px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  /* groups flatten into one scroll row; hide the "User"/"Admin" headers */
  .settings-v2 .s-nav-group { flex-direction: row; gap: 6px; }
  .settings-v2 .s-nav-h { display: none; }
  .settings-v2 .s-nav-i {
    flex: 0 0 auto;
    white-space: nowrap;
    padding: 8px 12px;
    border: 1px solid var(--color-line-soft);
  }
  /* dirty dot would overlap the chip edge — re-anchor it */
  .settings-v2 .s-nav-i .dot-dirty { right: 6px; top: 6px; }
  /* the side footer/status block is desktop-only chrome */
  .settings-v2 .s-side-foot { display: none; }
}
```

- [ ] **Step 3: Smoke at 390px (Playwright MCP).** With the local stack up, navigate to settings logged-in, `browser_resize` to 390×844, screenshot. Expected: a horizontal scrollable tab strip, panes full-width, no horizontal page overflow, apply-bar still pinned. Capture evidence under the Playwright output dir.

- [ ] **Step 4: Commit.**

```bash
git add gateway/webui/src/components/settings/settings-shell.css gateway/webui/src/components/settings/sidebar/sidebar.css
git commit -m "fix(webui): settings sidebar collapses to scrollable tab strip on narrow viewports"
```

---

## Task A9: Version bump (Android + iOS, fix Info.plist drift)

**Files:**
- Modify: `android/build.gradle.kts:48`
- Modify: `ios/project.yml:24-25`
- Regenerate: `ios/App/Info.plist` (via xcodegen — do not hand-edit)

No unit test (version constants).

- [ ] **Step 1: Bump Android.** In `android/build.gradle.kts` line 48, change `versionCode = 6; versionName = "0.1.4"` → `versionCode = 7; versionName = "0.1.5"`.

- [ ] **Step 2: Bump iOS spec.** In `ios/project.yml`, set `CFBundleShortVersionString: 0.1.5` and `CFBundleVersion: "3"`.

- [ ] **Step 3: Regenerate Info.plist.** Run: `source scripts/env.sh && ./scripts/ios-gen-project.sh` (or the documented xcodegen step). Confirm `ios/App/Info.plist` now shows `0.1.5` / `3` (clears the stale `0.1.3`/`1`).

- [ ] **Step 4: Verify.** Run: `grep -n "versionCode\|versionName" android/build.gradle.kts` and `grep -n "CFBundleShortVersionString\|CFBundleVersion" ios/App/Info.plist` → both show 0.1.5 and 7 / 3.

- [ ] **Step 5: Commit.**

```bash
git add android/build.gradle.kts ios/project.yml ios/App/Info.plist
git commit -m "chore(release): bump mobile 0.1.4 -> 0.1.5 (android vc7, ios bv3); fix Info.plist drift"
```

---

# Phase B — In-app OTA auto-updater

> Phase B builds on Phase A's `manifest.json`. The shared core is platform-pure; install triggers + UI are per-platform. Layering follows the mobile rules: SDK core → (Android) usecase/VM/Compose, (iOS) ObservableObject/SwiftUI.

## Task B1: Shared update models (commonMain)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/update/UpdateModels.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/update/UpdateModelsTest.kt`

**Interfaces:**
- Produces:
  - `@Serializable data class UpdateManifest(val android: AndroidRelease, val ios: IosRelease)`
  - `@Serializable data class AndroidRelease(val versionCode: Int, val versionName: String, val minSupportedBuild: Int = 0, val url: String, val notes: String = "")`
  - `@Serializable data class IosRelease(val bundleVersion: Int, val shortVersion: String, val minSupportedBuild: Int = 0, val bundleId: String, val url: String, val manifestUrl: String, val notes: String = "")`
  - `enum class UpdatePlatform { ANDROID, IOS }`
  - `data class InstalledVersion(val build: Int, val versionName: String)`
  - `sealed interface UpdateTarget { data class AndroidApk(val apkUrl: String) : UpdateTarget; data class IosItms(val itmsUrl: String) : UpdateTarget }`
  - `sealed interface UpdateStatus { data object UpToDate : UpdateStatus; data class Available(val latestBuild: Int, val versionName: String, val notes: String, val mandatory: Boolean, val target: UpdateTarget) : UpdateStatus; data class CheckFailed(val reason: String) : UpdateStatus }`
  - `data class ReleaseInfo(val build: Int, val versionName: String, val minSupportedBuild: Int, val downloadPath: String, val itmsPath: String?)`
  - `fun UpdateManifest.forPlatform(p: UpdatePlatform): ReleaseInfo`

- [ ] **Step 1: Write failing tests.** Create `UpdateModelsTest.kt`:

```kotlin
package io.sentient.mobilesdk.update

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private const val JSON_TEXT = """
{"android":{"versionCode":7,"versionName":"0.1.5","minSupportedBuild":5,"url":"/download/android/latest.apk","notes":"n"},
 "ios":{"bundleVersion":3,"shortVersion":"0.1.5","minSupportedBuild":2,"bundleId":"io.dev32.sentient","url":"/download/ios/latest.ipa","manifestUrl":"/download/ios/manifest.plist","notes":""}}
"""

class UpdateModelsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test fun deserializes_manifest() {
    val m = json.decodeFromString(UpdateManifest.serializer(), JSON_TEXT)
    assertEquals(7, m.android.versionCode)
    assertEquals(3, m.ios.bundleVersion)
  }

  @Test fun normalizes_android_release() {
    val m = json.decodeFromString(UpdateManifest.serializer(), JSON_TEXT)
    val r = m.forPlatform(UpdatePlatform.ANDROID)
    assertEquals(7, r.build)
    assertEquals(5, r.minSupportedBuild)
    assertEquals("/download/android/latest.apk", r.downloadPath)
    assertNull(r.itmsPath)
  }

  @Test fun normalizes_ios_release() {
    val m = json.decodeFromString(UpdateManifest.serializer(), JSON_TEXT)
    val r = m.forPlatform(UpdatePlatform.IOS)
    assertEquals(3, r.build)
    assertEquals("/download/ios/manifest.plist", r.itmsPath)
  }
}
```

- [ ] **Step 2: Run, expect failure.** Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "*UpdateModelsTest*"` → FAIL (unresolved).

- [ ] **Step 3: Implement the models.** Create `UpdateModels.kt` with the types from the Interfaces block and:

```kotlin
fun UpdateManifest.forPlatform(p: UpdatePlatform): ReleaseInfo = when (p) {
    UpdatePlatform.ANDROID -> ReleaseInfo(
        build = android.versionCode,
        versionName = android.versionName,
        minSupportedBuild = android.minSupportedBuild,
        downloadPath = android.url,
        itmsPath = null,
    )
    UpdatePlatform.IOS -> ReleaseInfo(
        build = ios.bundleVersion,
        versionName = ios.shortVersion,
        minSupportedBuild = ios.minSupportedBuild,
        downloadPath = ios.url,
        itmsPath = ios.manifestUrl,
    )
}
```

(Annotate the data classes `@Serializable`; import `kotlinx.serialization.Serializable`.)

- [ ] **Step 4: Run, expect pass.** Same gradle command → PASS.

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/update/UpdateModels.kt shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/update/UpdateModelsTest.kt
git commit -m "feat(mobile-sdk): update manifest models + per-platform normalization"
```

---

## Task B2: UpdateChecker (commonMain, unauthenticated fetch + compare)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/update/UpdateChecker.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/update/UpdateCheckerTest.kt`

**Interfaces:**
- Consumes: B1 models; the SDK's existing `deriveBaseUrl` (in `auth/AuthClient.kt`).
- Produces:
  - `fun deriveHostRoot(gatewayWsUrl: String): String` — `wss://host/api/v1/ws` → `https://host` (strips `/api/v1`).
  - `class UpdateChecker(private val hostRootUrl: String, private val httpClient: HttpClient, private val platform: UpdatePlatform, private val installed: InstalledVersion, private val log: Log = createLogger("update", "checker")) { suspend fun check(): UpdateStatus }`
- Behavior: GET `"$hostRootUrl/download/manifest.json"` with NO auth header; on non-2xx or exception/timeout → `CheckFailed`. Compute `mandatory = installed.build < release.minSupportedBuild`; `available = release.build > installed.build`. Resolve target: Android → `AndroidApk("$hostRootUrl${downloadPath}")`; iOS → `IosItms("itms-services://?action=download-manifest&url=$hostRootUrl${itmsPath}")`. Log status + builds only (no bearer, no content).

- [ ] **Step 1: Write failing tests with MockEngine.** Create `UpdateCheckerTest.kt`:

```kotlin
package io.sentient.mobilesdk.update

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private const val MANIFEST = """
{"android":{"versionCode":7,"versionName":"0.1.5","minSupportedBuild":0,"url":"/download/android/latest.apk","notes":""},
 "ios":{"bundleVersion":3,"shortVersion":"0.1.5","minSupportedBuild":2,"bundleId":"io.dev32.sentient","url":"/download/ios/latest.ipa","manifestUrl":"/download/ios/manifest.plist","notes":""}}
"""

private fun client(status: HttpStatusCode, body: String) = HttpClient(MockEngine { _ ->
  respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
}) { install(ContentNegotiation) { json() } }

class UpdateCheckerTest {
  @Test fun reports_up_to_date_when_installed_equals_latest() = runTest {
    val c = UpdateChecker("https://h", client(HttpStatusCode.OK, MANIFEST),
      UpdatePlatform.ANDROID, InstalledVersion(7, "0.1.5"))
    assertEquals(UpdateStatus.UpToDate, c.check())
  }

  @Test fun reports_optional_update_when_newer_build() = runTest {
    val c = UpdateChecker("https://h", client(HttpStatusCode.OK, MANIFEST),
      UpdatePlatform.ANDROID, InstalledVersion(6, "0.1.4"))
    val s = c.check() as UpdateStatus.Available
    assertEquals(7, s.latestBuild)
    assertTrue(!s.mandatory)
    assertEquals(UpdateTarget.AndroidApk("https://h/download/android/latest.apk"), s.target)
  }

  @Test fun reports_mandatory_when_below_min_supported() = runTest {
    val c = UpdateChecker("https://h", client(HttpStatusCode.OK, MANIFEST),
      UpdatePlatform.IOS, InstalledVersion(1, "0.1.3"))
    val s = c.check() as UpdateStatus.Available
    assertTrue(s.mandatory)
    assertTrue((s.target as UpdateTarget.IosItms).itmsUrl.startsWith("itms-services://"))
  }

  @Test fun reports_check_failed_on_500() = runTest {
    val c = UpdateChecker("https://h", client(HttpStatusCode.InternalServerError, ""),
      UpdatePlatform.ANDROID, InstalledVersion(7, "0.1.5"))
    assertTrue(c.check() is UpdateStatus.CheckFailed)
  }
}

class DeriveHostRootTest {
  @Test fun strips_api_v1_and_ws() {
    assertEquals("https://h:3000", deriveHostRoot("wss://h:3000/api/v1/ws"))
  }
}
```

- [ ] **Step 2: Run, expect failure.** Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "*UpdateCheckerTest*" --tests "*DeriveHostRootTest*"` → FAIL.

- [ ] **Step 3: Implement.** Create `UpdateChecker.kt`:

```kotlin
package io.sentient.mobilesdk.update

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.isSuccess
import io.sentient.mobilesdk.auth.deriveBaseUrl
import io.sentient.mobilesdk.log.Log
import io.sentient.mobilesdk.log.createLogger

private const val MANIFEST_PATH = "/download/manifest.json"
private const val ITMS_PREFIX = "itms-services://?action=download-manifest&url="

/** wss://host/api/v1/ws -> https://host (no /api/v1, no trailing slash). */
fun deriveHostRoot(gatewayWsUrl: String): String =
    deriveBaseUrl(gatewayWsUrl).removeSuffix("/api/v1")

class UpdateChecker(
    private val hostRootUrl: String,
    private val httpClient: HttpClient,
    private val platform: UpdatePlatform,
    private val installed: InstalledVersion,
    private val log: Log = createLogger("update", "checker"),
) {
    suspend fun check(): UpdateStatus {
        val release = fetchRelease() ?: return UpdateStatus.CheckFailed("fetch-failed")
        val mandatory = installed.build < release.minSupportedBuild
        val available = release.build > installed.build
        log.info(
            "check.result",
            mapOf("installed" to installed.build, "latest" to release.build, "mandatory" to mandatory),
        )
        if (!available) return UpdateStatus.UpToDate
        return UpdateStatus.Available(
            latestBuild = release.build,
            versionName = release.versionName,
            notes = "",
            mandatory = mandatory,
            target = targetFor(release),
        )
    }

    private suspend fun fetchRelease(): ReleaseInfo? = try {
        val resp: HttpResponse = httpClient.get("$hostRootUrl$MANIFEST_PATH")
        if (!resp.status.isSuccess()) {
            log.warn("check.http", mapOf("status" to resp.status.value)); null
        } else {
            resp.body<UpdateManifest>().forPlatform(platform)
        }
    } catch (e: Exception) {
        log.warn("check.error", mapOf("type" to (e::class.simpleName ?: "Exception"))); null
    }

    private fun targetFor(r: ReleaseInfo): UpdateTarget = when (platform) {
        UpdatePlatform.ANDROID -> UpdateTarget.AndroidApk("$hostRootUrl${r.downloadPath}")
        UpdatePlatform.IOS -> UpdateTarget.IosItms("$ITMS_PREFIX$hostRootUrl${r.itmsPath}")
    }
}
```

(Confirm the `Log` interface's `warn`/`info` signatures match `mapOf` props — mirror `AuthClient.kt` usage; it uses `log.info("msg", mapOf(...))` style. Adjust if the real signature differs.)

- [ ] **Step 4: Run, expect pass.** Same gradle command → PASS. (If `MockEngine` is missing from `commonTest`, add `io.ktor:ktor-client-mock` to the `commonTest` deps in `shared/mobile-sdk/build.gradle.kts`.)

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/update/UpdateChecker.kt shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/update/UpdateCheckerTest.kt shared/mobile-sdk/build.gradle.kts
git commit -m "feat(mobile-sdk): UpdateChecker — unauth manifest fetch + build compare + force flag"
```

---

## Task B3: AppUpdateInstaller interface (commonMain)

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/update/AppUpdateInstaller.kt`

**Interfaces:**
- Produces:
  - `sealed interface InstallResult { data object Launched : InstallResult; data object NeedsInstallPermission : InstallResult; data class Failed(val reason: String) : InstallResult }`
  - `interface AppUpdateInstaller { suspend fun start(target: UpdateTarget): InstallResult }`
- Android provides an `actual`-style implementation (Task B4). iOS does NOT implement this interface — its SwiftUI layer opens `UpdateTarget.IosItms.itmsUrl` directly via `UIApplication.open` (Task B7); the interface exists for the Android install handoff + a common UI contract.

No unit test (pure interface).

- [ ] **Step 1: Create the interface.**

```kotlin
package io.sentient.mobilesdk.update

sealed interface InstallResult {
    data object Launched : InstallResult
    data object NeedsInstallPermission : InstallResult
    data class Failed(val reason: String) : InstallResult
}

/** Hands an update [UpdateTarget] to the platform installer. Android downloads
 *  the apk + opens the system PackageInstaller; the system shows its own
 *  confirm UI (one-tap ceiling). iOS opens the itms-services URL in the UI layer. */
interface AppUpdateInstaller {
    suspend fun start(target: UpdateTarget): InstallResult
}
```

- [ ] **Step 2: Typecheck.** Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:compileKotlinMetadata` (or the module's common compile task) → success.

- [ ] **Step 3: Commit.**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/update/AppUpdateInstaller.kt
git commit -m "feat(mobile-sdk): AppUpdateInstaller interface + InstallResult"
```

---

## Task B4: Android installer — PackageInstaller + permission

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/update/AndroidUpdateInstaller.kt`
- Modify: `android/src/main/AndroidManifest.xml` (add `REQUEST_INSTALL_PACKAGES`)

**Interfaces:**
- Consumes: B3 `AppUpdateInstaller`, `UpdateTarget.AndroidApk`; an injected Ktor `HttpClient` (reuse `buildAuthHttpClient` from `android/src/main/kotlin/io/sentient/android/sdk/AuthHttpClient.kt` or the existing app client) and `android.content.Context`.
- Produces: `class AndroidUpdateInstaller(private val context: Context, private val httpClient: HttpClient, ...) : AppUpdateInstaller`.

No unit test (platform/Android framework; verified by Maestro + manual install on device per the matrix).

- [ ] **Step 1: Add the permission.** In `android/src/main/AndroidManifest.xml`, alongside the existing `INTERNET` permission:

```xml
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

- [ ] **Step 2: Implement the installer.** Create `AndroidUpdateInstaller.kt`:

```kotlin
package io.sentient.android.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.provider.Settings
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.readBytes
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.update.AppUpdateInstaller
import io.sentient.mobilesdk.update.InstallResult
import io.sentient.mobilesdk.update.UpdateTarget
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private val log = createLogger("android", "update-installer")
private const val SESSION_NAME = "sentient-update"

class AndroidUpdateInstaller(
    private val context: Context,
    private val httpClient: HttpClient,
) : AppUpdateInstaller {

    override suspend fun start(target: UpdateTarget): InstallResult {
        if (target !is UpdateTarget.AndroidApk) return InstallResult.Failed("wrong-target")
        if (!context.packageManager.canRequestPackageInstalls()) {
            routeToUnknownSources()
            log.info("install.needs-permission")
            return InstallResult.NeedsInstallPermission
        }
        return try {
            val bytes = download(target.apkUrl)
            commitSession(bytes)
            log.info("install.launched", mapOf("bytes" to bytes.size))
            InstallResult.Launched
        } catch (e: Exception) {
            log.warn("install.failed", mapOf("type" to (e::class.simpleName ?: "Exception")))
            InstallResult.Failed(e::class.simpleName ?: "error")
        }
    }

    private suspend fun download(url: String): ByteArray = withContext(Dispatchers.IO) {
        httpClient.get(url).readBytes()
    }

    private fun commitSession(apk: ByteArray) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite(SESSION_NAME, 0, apk.size.toLong()).use { out ->
                out.write(apk); session.fsync(out)
            }
            val intent = Intent(context, UpdateInstallReceiver::class.java)
            val pi = android.app.PendingIntent.getBroadcast(
                context, sessionId, intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_MUTABLE,
            )
            session.commit(pi.intentSender)
        }
    }

    private fun routeToUnknownSources() {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
```

Also create a minimal `UpdateInstallReceiver` (a `BroadcastReceiver` that the system invokes with the PackageInstaller status — for v1 it just logs; the system install UI is what the user interacts with). Add it to the manifest as a `<receiver>`. Keep it <40 lines.

- [ ] **Step 3: Build.** Run: `source scripts/env.sh && ./gradlew :android:assembleDebug` → success.

- [ ] **Step 4: Commit.**

```bash
git add android/src/main/kotlin/io/sentient/android/update/ android/src/main/AndroidManifest.xml
git commit -m "feat(android): PackageInstaller-based OTA installer + REQUEST_INSTALL_PACKAGES"
```

---

## Task B5: Android OTA UI — settings check, banner, force-gate, foreground wiring

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/settings/SettingsScreen.kt` (replace `checkForUpdatesStub`; add an update row)
- Create: `android/src/main/kotlin/io/sentient/android/update/UpdateViewModel.kt` (holds `StateFlow<UpdateStatus>`, calls `UpdateChecker` + `AndroidUpdateInstaller`)
- Create: `android/src/main/kotlin/io/sentient/android/update/UpdateBanner.kt` (Compose optional-update banner)
- Create: `android/src/main/kotlin/io/sentient/android/update/ForceUpdateScreen.kt` (Compose blocking gate)
- Modify: the nav graph under `android/src/main/kotlin/io/sentient/android/nav/` (route to `ForceUpdateScreen` when status is mandatory — read the nav files first to match the typed-route pattern)
- Modify: the presence relay under `android/src/main/kotlin/io/sentient/android/presence/` (trigger a check on foreground; respect COLD-START-SKIP)
- Modify: `android/src/main/kotlin/io/sentient/android/di/UserSessionManager.kt` (construct `UpdateChecker` with `deriveHostRoot(gatewayWsUrl)`, `InstalledVersion(BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME)`, `UpdatePlatform.ANDROID`, the app HttpClient; construct `AndroidUpdateInstaller`)

**Interfaces:**
- Consumes: B2 `UpdateChecker`/`deriveHostRoot`, B4 `AndroidUpdateInstaller`, B1 `UpdateStatus`/`InstalledVersion`/`UpdatePlatform`.
- The VM exposes `val status: StateFlow<UpdateStatus>`, `fun check()`, `fun install()` (delegates to installer with the current `Available.target`). Per android-architecture-mvi, business combine lives in a usecase if it grows; for v1 the VM may call the checker directly since it's a single source.

No new unit tests (UI + DI wiring; the logic is already covered by B2 commonTest). Covered by Maestro cases.

- [ ] **Step 1: Read the integration points.** Read the files under `android/src/main/kotlin/io/sentient/android/nav/` and `.../presence/` and `UserSessionManager.kt` to learn the typed-route enum, the presence-relay callback shape, and how SDK deps are constructed/scoped. Note the connection-scope vs app-scope boundary (android-di rule): the checker/installer belong to the connection scope (need gatewayWsUrl + http client).

- [ ] **Step 2: Construct deps in UserSessionManager.** Where the SDK + AuthClient are built (the explorer noted gateway URL + http client are available here), add:

```kotlin
val updateChecker = UpdateChecker(
    hostRootUrl = deriveHostRoot(gatewayWsUrl),
    httpClient = appHttpClient,            // reuse the existing app Ktor client
    platform = UpdatePlatform.ANDROID,
    installed = InstalledVersion(BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME),
)
val updateInstaller = AndroidUpdateInstaller(appContext, appHttpClient)
```

Expose both to the screen + nav layer through the existing DI surface (match how other deps are handed to ViewModels).

- [ ] **Step 3: Create the ViewModel.** `UpdateViewModel.kt`:

```kotlin
package io.sentient.android.update

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobilesdk.update.AppUpdateInstaller
import io.sentient.mobilesdk.update.UpdateChecker
import io.sentient.mobilesdk.update.UpdateStatus
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class UpdateViewModel(
    private val checker: UpdateChecker,
    private val installer: AppUpdateInstaller,
) : ViewModel() {
    private val _status = MutableStateFlow<UpdateStatus>(UpdateStatus.UpToDate)
    val status: StateFlow<UpdateStatus> = _status.asStateFlow()

    fun check() { viewModelScope.launch { _status.value = checker.check() } }

    fun install() {
        val s = _status.value
        if (s is UpdateStatus.Available) viewModelScope.launch { installer.start(s.target) }
    }
}
```

- [ ] **Step 4: Settings — replace the stub.** In `SettingsScreen.kt`, delete `checkForUpdatesStub()`; add an `UpdateRow` (hoisted state: `status: UpdateStatus`, `onCheck`, `onInstall`) rendered next to `VersionRow`. Show "Up to date" / "Update available — vX … [Update]" / "Check failed". The host (`MainActivity`/settings host) wires it to `UpdateViewModel`. Add testTags `settings-update`, `settings-update-action`.

- [ ] **Step 5: Banner + force-gate composables.** `UpdateBanner.kt` — a non-blocking top banner shown when `status is Available && !mandatory`, `[Update]` → `onInstall`, dismissible. `ForceUpdateScreen.kt` — a full-screen blocking composable with copy + a single `[Update]` button → `onInstall`, no back. Each has a `@Preview`.

- [ ] **Step 6: Wire the force-gate into nav.** In the nav graph, when `status is Available && mandatory`, route to `ForceUpdateScreen` ahead of the normal destination (the auth-gated entry). Follow the existing typed-route + state-driven gate pattern (mobile-navigation rule). The optional banner is an in-screen overlay on the chat/settings screens, not a route.

- [ ] **Step 7: Foreground-trigger the check.** In the presence relay, on a real foreground (NOT the cold-start-skip first foreground), call `updateViewModel.check()`. Reuse the existing relay callback; do not add a background scheduler.

- [ ] **Step 8: Build + lint.** Run: `source scripts/env.sh && ./gradlew :android:assembleDebug :android:lintDebug` → clean (or only pre-existing).

- [ ] **Step 9: Commit.**

```bash
git add android/src/main/kotlin/io/sentient/android/update/ android/src/main/kotlin/io/sentient/android/settings/SettingsScreen.kt android/src/main/kotlin/io/sentient/android/nav/ android/src/main/kotlin/io/sentient/android/presence/ android/src/main/kotlin/io/sentient/android/di/UserSessionManager.kt
git commit -m "feat(android): OTA UI — settings check, optional banner, force-update gate, foreground check"
```

---

## Task B6: iOS installer trigger (outbound itms-services open)

**Files:**
- Create: `ios/App/Update/UpdateInstaller.swift`

**Interfaces:**
- Produces: `enum UpdateInstaller { static func start(itmsUrl: String) }` — calls `UIApplication.shared.open(url)`. No Kotlin actual needed; the SwiftUI layer reads `UpdateTarget.IosItms.itmsUrl` from the KMP `UpdateStatus.Available` and passes it here.

No unit test (single platform call; manual on registered device per the matrix).

- [ ] **Step 1: Implement.**

```swift
import UIKit
import shared   // KMP framework module name; confirm from an existing import in the app

// Opens the itms-services manifest URL → the OS downloads + installs over the
// existing app. Works only on UDID-registered devices (ad-hoc). Outbound open
// only; no inbound URL-scheme handler is needed.
enum UpdateInstaller {
    static func start(itmsUrl: String) {
        guard let url = URL(string: itmsUrl) else { return }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }
}
```

- [ ] **Step 2: Build.** Run: `source scripts/env.sh && ./scripts/ios-setup.sh` then build the app target in Xcode (or `xcodebuild` per the project's debug build) → success.

- [ ] **Step 3: Commit.**

```bash
git add ios/App/Update/UpdateInstaller.swift
git commit -m "feat(ios): outbound itms-services OTA install trigger"
```

---

## Task B7: iOS OTA UI — settings check, banner, force-gate, scenePhase wiring

**Files:**
- Create: `ios/App/Update/UpdateModel.swift` (`@MainActor ObservableObject` holding `UpdateStatus`, calling KMP `UpdateChecker` + `UpdateInstaller`)
- Create: `ios/App/Update/UpdateBanner.swift` (optional-update banner view)
- Create: `ios/App/Update/ForceUpdateView.swift` (blocking gate view)
- Modify: `ios/App/Settings/SettingsView.swift` (replace `checkForUpdatesStub`; add an update row)
- Modify: `ios/App/RootView.swift` (route to `ForceUpdateView` when mandatory; show banner overlay otherwise — read it first)
- Modify: `ios/App/SentientApp.swift` (trigger a check on `scenePhase == .active`, skipping the first/cold-start activation — read it first)

**Interfaces:**
- Consumes: KMP `UpdateChecker`, `deriveHostRoot`, `InstalledVersion`, `UpdatePlatform.ios`, `UpdateStatus` (exposed through the `shared` framework). Build `InstalledVersion(build:Int32(Bundle CFBundleVersion), versionName: CFBundleShortVersionString)`.
- `UpdateModel` exposes `@Published var status: UpdateStatus`, `func check() async`, `func install()`.

No new unit tests (UI; logic covered by B2 commonTest). Covered by Maestro + manual.

- [ ] **Step 1: Read integration points.** Read `RootView.swift`, `SentientApp.swift`, `SettingsView.swift` to learn the root gate structure (how auth gates chat vs login), the `scenePhase` handling (or add it), and the settings row pattern + how the KMP `shared` types are referenced from Swift.

- [ ] **Step 2: Create UpdateModel.** `UpdateModel.swift` — construct `UpdateChecker(hostRootUrl: deriveHostRoot(gatewayWsUrl), httpClient: <app Ktor client>, platform: .ios, installed: InstalledVersion(build:..., versionName:...))`. `check()` calls the suspend `check()` (bridged to Swift async); `install()` reads `(status as? UpdateStatus.Available)?.target as? UpdateTarget.IosItms` and calls `UpdateInstaller.start(itmsUrl:)`. Confirm how other Swift code obtains the gateway URL + a Ktor client (mirror `AuthClient` usage on iOS).

- [ ] **Step 3: Settings — replace the stub.** In `SettingsView.swift`, remove `checkForUpdatesStub()`; add an update row bound to `UpdateModel` showing up-to-date / available + Update button / check-failed.

- [ ] **Step 4: Banner + force-gate views.** `UpdateBanner.swift` (shown when `.available && !mandatory`), `ForceUpdateView.swift` (full-screen, single Update button, no dismiss).

- [ ] **Step 5: Wire into RootView.** When status is mandatory → render `ForceUpdateView` instead of the normal authed content; otherwise overlay `UpdateBanner` when an optional update exists. Gate stays auth-first (a transport drop never bounces to login — mobile-navigation rule).

- [ ] **Step 6: scenePhase check.** In `SentientApp.swift`, observe `scenePhase`; on transition to `.active` AFTER the first activation, call `updateModel.check()`. Skip the cold-start first activation (mirror the relay COLD-START-SKIP).

- [ ] **Step 7: Build.** Build the iOS app target → success.

- [ ] **Step 8: Commit.**

```bash
git add ios/App/Update/ ios/App/Settings/SettingsView.swift ios/App/RootView.swift ios/App/SentientApp.swift
git commit -m "feat(ios): OTA UI — settings check, optional banner, force-update gate, scenePhase check"
```

---

# Final verification (before handover)

- [ ] **Gateway unit + typecheck + lint.** Run: `source scripts/env.sh && cd gateway && bun run ci` → green. Also `cd gateway/webui && bun run typecheck && bun run lint`.
- [ ] **Shared SDK tests.** Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest` → green (UpdateModels + UpdateChecker).
- [ ] **Android build.** `./gradlew :android:assembleDebug` → success.
- [ ] **iOS build.** debug build → success.
- [ ] **Web E2E (Playwright MCP, local stack).** Run every row of the spec's Web matrix at 1280×900 + 390×844: `/download` pre-auth, mobile layout, apk download MIME, iOS install href, manifest.json shape, missing-artifact 404, settings entry→page, settings narrow tab strip, plist correctness. Capture evidence.
- [ ] **Native OTA E2E (Maestro, emulator/simulator).** Run the spec's Native matrix: up-to-date, optional banner, manual check finds update, force-update gate, check-fails-gracefully, unauth self-heal, Android unknown-sources route.
- [ ] **Flagged manual (real devices).** Android real install-confirm + cross-build upgrade; iOS itms-services install on a registered-UDID device. Document results in handover.
- [ ] **finishing-a-development-branch** to decide merge/PR (do NOT merge to develop without the user's explicit go).

---

## Self-review (plan vs spec)

- **Spec §1 routing** → A2 + A5. **§2 storage/deploy/manifest** → A1 + A6. **§3 landing page** → A4. **§4 settings entry** → A7. **§5 settings mobile fix** → A8. **§6 version bump** → A9. **§7 iOS plist** → A3. **§8 shared update core** → B1 + B2 + B3. **§9 Android install** → B4. **§10 iOS install** → B6. **§11 OTA UI + force gate + foreground** → B5 (Android) + B7 (iOS). All spec sections mapped.
- **E2E matrix** → Final verification section runs the full web + native matrices; iOS-on-device flagged manual (matches spec).
- **Placeholders:** integration tasks (B5/B7 nav + presence/scenePhase, A7 QR) say "read file X, follow pattern Y" with exact paths rather than inventing code against files not yet read — this is a deliberate instruction, not a TBD. All testable cores (handlers, plist, models, checker) carry complete code + tests.
- **Type consistency:** `UpdateManifest`/`AndroidRelease`/`IosRelease`/`forPlatform`/`ReleaseInfo`/`UpdateStatus`/`UpdateTarget`/`InstalledVersion`/`UpdatePlatform`/`deriveHostRoot`/`AppUpdateInstaller`/`InstallResult` are defined once (B1/B2/B3) and consumed with the same names in B4–B7. Manifest field names (`versionCode`, `bundleVersion`, `minSupportedBuild`, `url`, `manifestUrl`) are identical across the gateway JSON (A6), the plist reader (A3), and the KMP model (B1).
