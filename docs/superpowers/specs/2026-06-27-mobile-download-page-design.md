# Mobile Download Page + OTA-ready Artifact Serving — Design

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

Two coupled asks:

1. A public, **non-auth-gated** path that serves a mobile-first download/install page and
   the artifacts beneath it, forward-compatible with OTA.
2. Fix the web UI's behavior on a narrow mobile-browser viewport (the settings shell
   currently breaks below 880px).

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
  "android": { "versionCode": 7, "versionName": "0.1.5",
               "url": "/download/android/latest.apk", "notes": "" },
  "ios": { "shortVersion": "0.1.5", "bundleVersion": "3",
           "bundleId": "io.dev32.sentient",
           "url": "/download/ios/latest.ipa",
           "manifestUrl": "/download/ios/manifest.plist" }
}
```

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

## E2E matrix (inline, mandatory)

Web cases drive against the running local stack via Playwright MCP (desktop 1280×900 and
mobile 390×844). Native on-device install is flagged for manual verify.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Page loads pre-auth | 1280×900 | logged OUT, no session | GET `/download` | Page renders, both buttons + version | `downloads` page-serve INFO; no auth redirect |
| Page mobile layout | 390×844 | logged out | GET `/download` | Single column, tap targets ≥44px, no overflow | same |
| APK download | 1280×900 | apk present | click Download APK | APK downloads, correct MIME | artifact-serve INFO w/ bytes |
| iOS install href | 390×844 | manifest present | inspect Install button | href = `itms-services://…/download/ios/manifest.plist` | plist-generate INFO |
| manifest.json shape | 1280×900 | deployed | GET `/download/manifest.json` | JSON w/ android+ios versions/urls | INFO |
| Artifact missing | 1280×900 | apk absent | GET `/download/android/latest.apk` | clean 404 | WARN reason=missing |
| Settings entry → page | 1280×900 | logged in | open Get-the-app, click | `/download` opens new tab | settings INFO |
| Settings narrow layout | 390×844 | logged in | open settings | sidebar → top tab strip, panes full-width, no overflow | — |
| Plist correctness | — | deployed | GET `/download/ios/manifest.plist` | valid plist, absolute https URLs, bundle-id match | INFO |

> iOS actual on-device itms install is **not chromium-testable** → flagged for manual
> verify on a registered device in handover.

## Open item (non-blocking)

User reports serving on `80` + `443`, but exploration found only a `:443` (and `:8888`)
listener in `deploy/mac-prod/`, no `:80`. itms-services + APK trust both need HTTPS (present
via the acme cert), so `/download` works on 443. Add an `:80→:443` redirect if `:80` isn't
already wired, so a bare `http://sentient.dev32.io/download` typed on a phone doesn't
dead-end. Verify the actual `:80` state during implementation.

## Out of scope (YAGNI)

- The in-app OTA updater client (Android `PackageInstaller` flow, iOS update-available
  check) — this design only makes the *server* path OTA-ready (manifest + artifacts).
- UDID self-registration flow for non-family iOS devices.
- Auto-incrementing version in CI.
