# Mobile Download Page + In-App OTA Auto-Update — Design

**Date:** 2026-06-27
**Branch:** `feature/mobile-download-page`
**Status:** Approved design, pre-implementation

## Problem

Production moved to a dedicated Apple-silicon Mac mini (`deploy/mac-prod/`) terminating
HTTPS on `443`. Mobile app artifacts (`.apk` / `.ipa`) were previously scp'd to a
*separate* external file server (`scripts/deploy-mobile.sh` + gitignored
`release.local.conf`). Now that the stack is consolidated onto one host we want the
gateway itself to serve the artifacts behind a clean public URL, with a human-facing
landing page to download/install the apps — and the path must double as the root for a
future in-app OTA update mechanism.

Three coupled asks:

1. A public, **non-auth-gated** path that serves a mobile-first download/install page and
   the artifacts beneath it, forward-compatible with OTA.
2. An **in-app OTA auto-updater** that rides that path: the apps detect a newer build,
   notify the user, and install it in one tap — as automated as sideloaded apps allow.
3. Fix the web UI's behavior on a narrow mobile-browser viewport (the settings shell
   currently breaks below 880px).

**Automation ceiling (the hard limit we design to):** zero-tap silent install is
impossible for sideloaded apps on both platforms — Android needs device-owner/MDM, iOS
ad-hoc cannot install programmatically at all. The realistic ceiling is **one-tap**: auto
check + auto notify + a single tap that hands off to the OS installer (which always shows a
system confirm dialog). Android *can* pre-download the APK to make the tap instant; iOS
cannot. v1 downloads on tap.

The apps already carry `checkForUpdatesStub()` call sites in both settings screens
(referencing the original §12.2 P2 carry) — this design replaces those stubs.

Also discovered during exploration: the mobile version bump was **forgotten** after
PR #13 (network-path reconnect on both platforms + auth-error routing) merged today; and
iOS `Info.plist` has drifted from `project.yml` (the xcodegen source of truth). Folded
into this work.

## Decisions (locked with user)

- **Path:** `/download` — human landing page AND the OTA root. Machine endpoints live
  beneath it (`/download/manifest.json`, `/download/android/latest.apk`, etc.). Public,
  no auth gate. (`/get` rejected as too generic/misleading for later OTA use.)
- **Serving model:** gateway serves artifacts from a host dir mounted into the container.
  `deploy-mobile.sh` scp's to the Mac mini. Single host, same TLS, OTA-native. (Keeping a
  separate file server rejected — two hosts, cross-origin OTA, extra TLS.)
- **iOS distribution:** itms-services OTA, **registered family devices only** (ad-hoc
  provisioning — installs only on UDIDs in the profile, which is the intended audience).
  Page states this constraint plainly. (UDID self-registration help-flow and full
  iOS-defer both rejected.)
- **Mobile fix scope:** BOTH the new `/download` page (mobile-first by construction) AND
  the settings shell narrow-viewport breakage (sidebar → top tab strip at <880px).
- **Version bump:** folded in — Android `0.1.4→0.1.5` (`versionCode 6→7`), iOS
  `0.1.4→0.1.5` (`CFBundleVersion 2→3`), regenerate `Info.plist` via xcodegen to clear
  the stale `0.1.3/1` drift.
- **OTA automation target:** check + notify + one-tap install, **download-on-tap**. No
  Android background pre-download in v1 (rejected — storage/cleanup/partial-download cost).
- **Force update:** **full force-update gate now.** Manifest carries `minSupportedBuild`
  per platform; if the installed build < `minSupportedBuild`, the app shows a blocking
  "Update required" screen before the normal nav gate. (Field-only-defer and skip rejected.)
- **Check cadence:** on app **foreground/resume** + the existing manual "Check for updates"
  settings button. No background daemon. (Aligns with the no-server-heartbeat battery
  rule — visibility-triggered, not periodic. Periodic background rejected.)
- **OTA check is unauthenticated:** the manifest endpoint is public, so a build with an
  expired/broken token can still self-update (self-heal). No bearer on the check.
- **Version comparison uses the monotonic build number** — Android `versionCode` (int),
  iOS `CFBundleVersion` (int) — not semver. Both are integers we control on every release.

## Architecture

### 1. Routing & access (gateway)

New **public** route namespace `/download/*` in `gateway/src/api/router.ts`, matched
**before the auth gate and before the SPA static fallback** — no PASETO session required.

New handler module `gateway/src/api/handlers/downloads.ts` (tagged logger
`["sentient","api","downloads"]`):

| Endpoint | Returns |
|---|---|
| `GET /download` | Landing page HTML (§3) |
| `GET /download/manifest.json` | OTA version feed (both platforms) |
| `GET /download/android/latest.apk` | APK, MIME `application/vnd.android.package-archive` |
| `GET /download/ios/latest.ipa` | IPA, MIME `application/octet-stream` |
| `GET /download/ios/manifest.plist` | itms-services manifest, **generated on the fly from `manifest.json`** so it can never go stale |

Missing artifact → clean `404` + WARN log with `reason`. Every serve logs INFO with
byte count + elapsed ms per the logging rules. String previews ≤120 chars; never log
artifact bytes.

### 2. Artifact storage & deploy flow

- Host dir `~/.sentient/releases/` on the Mac mini, mounted **read-only** into the
  container at `/app/releases` (add the volume to `deploy/mac-prod/docker-compose.yml`).
  URL namespace `/download` maps to disk dir `releases` — mapping is explicit in the
  handler; they need not share a name.
- New `gateway/config.yaml` values (grouped under a `downloads:` section, each with an
  inline comment):
  - `artifacts_dir` — container path to the mounted release dir (`/app/releases`).
  - `public_base_url` — absolute HTTPS origin (e.g. `https://sentient.dev32.io`), required
    because **itms-services plist URLs must be absolute HTTPS**.
- `scripts/deploy-mobile.sh`: change the scp target from the old external file server to
  `mini0:~/.sentient/releases/<platform>/latest.<ext>`, and write/update
  `~/.sentient/releases/manifest.json` with the versions the build scripts already read:

```json
{
  "android": { "versionCode": 7, "versionName": "0.1.5", "minSupportedBuild": 0,
               "url": "/download/android/latest.apk", "notes": "" },
  "ios": { "bundleVersion": 3, "shortVersion": "0.1.5", "minSupportedBuild": 0,
           "bundleId": "io.dev32.sentient",
           "url": "/download/ios/latest.ipa",
           "manifestUrl": "/download/ios/manifest.plist", "notes": "" }
}
```

`minSupportedBuild` is the force-update floor (operator bumps it via `deploy-mobile.sh`
when shipping a breaking change; `0` = no forced update). URLs are stored **relative**; the
plist generator and the apps resolve them against `public_base_url` / the gateway host.
`ios.bundleVersion` is numeric here for the app's integer compare; the plist generator
stringifies it where the plist format requires a string.

### 3. The `/download` landing page — mobile-first

**Server-rendered standalone HTML** emitted by the handler (own minimal CSS, importing the
shared design-token CSS variables), **not** inside the authed Preact SPA. This guarantees
the page loads pre-auth on a fresh phone with zero JS-auth risk. (A public SPA route was
rejected: it would force the SPA boot to allow unauthenticated rendering — more risk for no
gain on a two-button page.)

Content:
- App name / logo.
- **Android:** `[ Download APK ↓ ]` → `/download/android/latest.apk`.
- **iOS:** `[ Install on iPhone ↗ ]` →
  `itms-services://?action=download-manifest&url=<public_base_url>/download/ios/manifest.plist`.
- Current version line, read from `manifest.json`.
- Note under iOS: *"⚠ Registered devices only (ad-hoc provisioning)."*

Mobile-first by construction: single column, large tap targets (≥44px), renders
identically on desktop and phone.

### 4. Settings entry

A small **"Get the app"** section — a lightweight pane (or a row in an existing nav group)
built from the existing `Card` / `Row` / `PaneHead` primitives, containing a short blurb, a
button that opens `/download` in a new tab, and a QR code of the `/download` URL for
"open on your phone." No auth-sensitive data — just a link. Logger
`["sentient","webui","settings","get-app"]`.

### 5. Settings mobile fix (`settings-shell.css`)

Add a `<880px` breakpoint (verified at 390px): the 240px sidebar collapses to a
**horizontal scrollable top tab strip**; panes go full-width; the apply-bar stays pinned to
the bottom. (A drawer was rejected — the top-tab strip carries less state, needs no overlay
/ focus-trap, and matches the existing flat tab model.)

### 6. Version bump

- `android/build.gradle.kts`: `versionCode 6→7`, `versionName "0.1.4"→"0.1.5"`.
- `ios/project.yml`: `CFBundleShortVersionString 0.1.4→0.1.5`, `CFBundleVersion "2"→"3"`.
- Regenerate `ios/App/Info.plist` via `scripts/ios-gen-project.sh` (xcodegen) to clear the
  stale `0.1.3 / "1"` drift — never hand-edit Info.plist.

### 7. iOS OTA plist details

Generated on the fly from `manifest.json` values:
- `bundle-identifier` = `io.dev32.sentient`.
- `software-package` asset = the absolute HTTPS ipa URL.
- `display-image` (57px) + `full-size-image` (512px) assets = icon PNGs added under
  `/download/ios/` (new assets to add to the release dir).
- All URLs absolute HTTPS via `public_base_url`.

## In-app OTA auto-updater

Built in two layers: shared KMP decision logic (commonMain), and a thin per-platform
install trigger behind an interface. Dependencies flow inward (UI → checker interface →
platform installer), per the architecture rules. Each unit is one file, under the line
limit.

### 8. Shared update core — `shared/mobile-sdk` `io.sentient.mobilesdk.update`

New package (commonMain), reusing the existing Ktor client + log idiom. Split into focused
files (one module per file):

- **`UpdateManifest`** — `@Serializable` data class mirroring `/download/manifest.json`
  (android + ios blocks, `minSupportedBuild`, numeric build, urls, notes). `ignoreUnknownKeys`.
- **`InstalledVersion`** — the running build: `buildNumber: Int` + `versionName: String`,
  supplied per platform at SDK init (Android `BuildConfig.VERSION_CODE/_NAME`, iOS
  `CFBundleVersion/ShortVersionString`). No new platform accessor needed — the apps already
  read these; they pass them in.
- **`UpdateStatus`** — sealed: `UpToDate`, `UpdateAvailable(latestBuild, versionName, target, notes, mandatory)`,
  `CheckFailed(reason)`. `mandatory = installed.buildNumber < manifest.minSupportedBuild`.
- **`UpdateTarget`** — platform-resolved install payload: Android → absolute APK URL; iOS →
  absolute `itms-services://…manifest.plist` URL. Built in common from the manifest +
  gateway host.
- **`UpdateChecker`** — `suspend fun check(): UpdateStatus`. GETs
  `<host-root>/download/manifest.json` **without auth**, picks the platform block, compares
  build numbers, computes `mandatory`. Host root derived from the existing gateway config by
  stripping `/api/v1`. Logger `["sentient","mobile-sdk","update"]`; logs versions/ids/status
  only (manifest is non-sensitive, but still no bearer in logs — sanitizer covers it).
- **`AppUpdateInstaller`** — `expect`/interface: `suspend fun start(target: UpdateTarget)`.
  Common owns the decision; platforms own the install handoff.

Timeout the manifest GET (no unbounded wait, per error-handling rules); a failed/timed-out
check returns `CheckFailed`, never throws into the UI.

### 9. Android install trigger (android app module)

`AppUpdateInstaller` actual:
1. Pre-flight `packageManager.canRequestPackageInstalls()`. If false → route the user to
   `ACTION_MANAGE_UNKNOWN_APP_SOURCES` to grant once, then resume.
2. Download the APK (Ktor, target URL) to app-private cache.
3. Install via **`PackageInstaller` session** (`MODE_FULL_INSTALL`): create session, stream
   the APK bytes, `commit()` → the system shows its install-confirm UI (the unavoidable
   one-tap). No `FileProvider` needed for the session API.

Manifest changes: add `android.permission.REQUEST_INSTALL_PACKAGES` to
`android/src/main/AndroidManifest.xml`. Logger `["sentient","android","update"]`; log
bytes/elapsed/states, never content.

### 10. iOS install trigger (iOS app)

`AppUpdateInstaller` actual: `UIApplication.shared.open(URL(string: <itms-services target>))`.
This is an **outbound** open of the system `itms-services` scheme — the OS downloads +
installs over the existing app. No inbound URL-scheme handler, no `CFBundleURLSchemes`
needed. (If `canOpenURL` is used as a guard, add `itms-services` to
`LSApplicationQueriesSchemes` in `project.yml`; `open` alone does not require it.) Install
succeeds only on a device whose UDID is in the ad-hoc profile — matches the page's
"registered devices only" note. Logger `["sentient","ios","update"]`.

### 11. OTA UI + force-update gate + foreground wiring

Three surfaces, mirrored on Android (Compose) and iOS (SwiftUI):

- **Settings "Check for updates"** — replace `checkForUpdatesStub()` with a real
  `UpdateChecker.check()` call; render `UpToDate` / `UpdateAvailable` (version + notes +
  `[Update]` → `AppUpdateInstaller.start`) / `CheckFailed`.
- **Non-blocking "Update available" banner** — a screen-level overlay shown when a foreground
  check returns an optional (`mandatory = false`) update. `[Update]` triggers install;
  dismissible.
- **Force-update gate** — when `mandatory = true`, the **state-driven navigation gate**
  (per the architecture rule) routes to a full-screen blocking "Update required" screen
  before any normal screen. Only action is `[Update]`; no dismiss, no app use until updated.
- **Foreground check wiring** — Android: app `ON_RESUME`/foreground observer → `check()`.
  iOS: `scenePhase == .active` → `check()`. Plus the manual settings button. No background
  scheduler.

The gate decision lives in shared `UpdateStatus`; each platform's nav gate consumes it. UI
files stay one-component-per-file; the gate screen and banner are their own files.

## E2E matrix (inline, mandatory)

Web cases drive against the running local stack via Playwright MCP (desktop 1280×900 and
mobile 390×844). Native OTA cases drive via Maestro on emulator/simulator (per the mobile
e2e rules); the actual OS install-confirm dialog + cross-build upgrade are flagged manual.

**Web — `/download` page, manifest, settings (Playwright MCP):**

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Page loads pre-auth | 1280×900 | logged OUT, no session | GET `/download` | Page renders, both buttons + version | `downloads` page-serve INFO; no auth redirect |
| Page mobile layout | 390×844 | logged out | GET `/download` | Single column, tap targets ≥44px, no overflow | same |
| APK download | 1280×900 | apk present | click Download APK | APK downloads, correct MIME | artifact-serve INFO w/ bytes |
| iOS install href | 390×844 | manifest present | inspect Install button | href = `itms-services://…/download/ios/manifest.plist` | plist-generate INFO |
| manifest.json shape | 1280×900 | deployed | GET `/download/manifest.json` | JSON w/ both blocks, `minSupportedBuild`, urls | INFO |
| Artifact missing | 1280×900 | apk absent | GET `/download/android/latest.apk` | clean 404 | WARN reason=missing |
| Settings entry → page | 1280×900 | logged in | open Get-the-app, click | `/download` opens new tab | settings INFO |
| Settings narrow layout | 390×844 | logged in | open settings | sidebar → top tab strip, panes full-width, no overflow | — |
| Plist correctness | — | deployed | GET `/download/ios/manifest.plist` | valid plist, absolute https URLs, bundle-id match | INFO |

**Native — in-app OTA (Maestro, Android + iOS):**

| Case | Platform | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Up to date | both | installed build == manifest | open Settings → Check for updates | "Up to date" | `update` check INFO status=up-to-date |
| Optional update banner | both | manifest build > installed, not mandatory | foreground app | non-blocking "Update available" banner w/ version+notes | `update` INFO status=available mandatory=false |
| Manual check finds update | both | manifest build > installed | Settings → Check for updates | "Update available" + `[Update]` | check INFO available |
| Force-update gate | both | installed < `minSupportedBuild` | foreground app | full-screen "Update required", no dismiss, app unusable | check INFO mandatory=true; nav routes to gate |
| Check fails gracefully | both | manifest endpoint down/timeout | Settings → Check for updates | "Check failed", app still usable | WARN reason=check-failed; no throw |
| Unauth self-heal check | both | expired token | foreground app | update check still runs (no auth) | check INFO; no bearer; no auth redirect |
| Android unknown-sources | Android | install-packages not granted | tap `[Update]` | routed to grant screen, returns to install | `update` INFO state=request-install-permission |

> **Flagged manual (not emulator-automatable):** the actual OS install-confirm dialog +
> real cross-build upgrade — Android on a device with the APK, **iOS itms-services on a
> registered-UDID device** (ad-hoc, not simulator-installable). Verify on real devices in
> handover.

## Transport

HTTPS-only. The stack serves `/download` and all artifacts over `443` (acme cert on
`sentient.dev32.io`) — required anyway for itms-services + APK trust. No `:80` listener,
no HTTP→HTTPS redirect.

## Phasing (one branch, two phases)

- **Phase A — server foundation:** `/download` routes + handler, `manifest.json`, plist
  generation, mounted release dir, `deploy-mobile.sh` retarget, config values, landing page,
  settings "Get the app" entry, settings mobile fix, version bump. Independently shippable.
- **Phase B — in-app OTA:** shared `update` core, Android installer + permission, iOS open
  trigger, OTA UI (settings check, banner, force-update gate), foreground wiring. Builds on
  Phase A's manifest.

## Out of scope (YAGNI)

- Android background **pre-download** of the APK (v1 downloads on tap).
- Periodic **background** update checks (WorkManager / BGAppRefreshTask) — foreground +
  manual only.
- UDID self-registration flow for non-family iOS devices.
- Auto-incrementing version in CI.
- Zero-tap / silent install (impossible without device-owner/MDM; iOS impossible entirely).
