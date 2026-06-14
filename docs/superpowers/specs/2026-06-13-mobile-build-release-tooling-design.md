# Mobile Build/Release Tooling — Design

**Date:** 2026-06-13
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** Local, secret-driven build + deploy tooling for the iOS (`.ipa`) and Android (`.apk`) clients. Reproducible signed artifacts from a developer machine, deployed to the self-hosted file server. **Not** a CI-machine build.

## 1. Motivation

Producing a signed iOS `.ipa` today is a ~5-step manual chain (build the KMP XCFramework via gradle → `xcodegen generate` → `xcodebuild archive` → `xcodebuild -exportArchive` → `scp`), each step requiring rediscovery of team id, provisioning profile, and signing identity. Android has **no release signing configured at all** — `assembleRelease` currently yields an unsigned apk. Every release is bespoke gymnastics and burns agent tokens re-deriving the same facts.

Goal: two symmetric one-command entry points that produce a signed, installable artifact and (optionally) deploy it — driven entirely by local/provided secrets, with **nothing personal committed to this public repo**.

## 2. Goals / Non-Goals

**Goals**
- `./scripts/build-android.sh` → signed `Sentient.apk`; deploy **opt-in** (`--deploy`).
- `./scripts/build-ios.sh` → signed ad-hoc `Sentient.ipa`; deploy **opt-in** (`--deploy`).
- iOS signs with the **local macOS Keychain identity** + Xcode auto-managed profiles only — no cert/key/credential ever in the repo or read by the script.
- Android release signing from scratch (keystore + `signingConfig`).
- A single, documented, gitignored home for every secret/identity value; committed `.example` templates.
- Public-repo safe: committed code references only ENV/placeholders; a pre-commit guard blocks personal info.
- Idiomatic per platform: **gradle** for Android, **fastlane** for iOS.
- **Discoverable**: relevant docs (root `CLAUDE.md` commands, README/release doc, `ios`/`android` `CLAUDE.md`, the `ios-xcodebuild` rule) record that these scripts exist and how to run them.

**Non-Goals (YAGNI for v1)**
- CI-machine / cloud builds; GitHub Actions.
- TestFlight / App Store / Play Store upload (`match`, `pilot`, `supply`, `.aab`).
- Automated version bumping / lockstep enforcement across `project.yml` ↔ `build.gradle.kts` ↔ module versions (scripts only **echo** the version they build; bump stays manual).
- Multi-developer cert sharing (`match`). Single solo developer, local keychain.

## 3. Guiding principle — "committed code, gitignored identity"

Every committed file (Fastfile, gradle `signingConfig`, scripts) references **only ENV vars / placeholders**. All personal and secret values live in **gitignored local files, each with a committed `.example`** — mirroring the repo's existing `local.properties(.example)` and `Local.xcconfig(.example)` convention. Scripts **fail loudly** with a pointer to the `.example` when a required config is absent. A contributor with no secrets can still build the **debug** variants.

This is the same secret-injection channel the project already uses; we extend it, not replace it.

## 4. Architecture

### 4.1 Entry points

Deploy is **opt-in**: default is build-only (artifact stays local); pass `--deploy` to scp it. No accidental push to the file server.

```
Android:  ./scripts/build-android.sh [--deploy]
            └─ ./gradlew :android:assembleRelease        # signed via signingConfig
            └─ scripts/deploy-mobile.sh <apk>            # only if --deploy

iOS:      ./scripts/build-ios.sh [--deploy]
            └─ bundle exec fastlane ios adhoc            # thin wrapper; fastlane does the work
                 0. ./gradlew :shared:mobile-data:assembleMobileDataReleaseXCFramework
                 1. cp release xcframework → build/XCFrameworks/MobileData.xcframework  (stable path)
                 2. ensure ios/App/Local.xcconfig exists; xcodegen generate
                 3. gym: archive + export ad-hoc, automatic signing, -allowProvisioningUpdates
                 4. scripts/deploy-mobile.sh <ipa>       # only if --deploy
```

- **Android** = pure gradle + a thin bash wrapper. No fastlane on Android.
- **iOS** = fastlane `gym`, reusing the **local keychain cert + Xcode auto-managed provisioning profiles** (the path proven to work by hand). **No `match`** — match stores certs in a private git repo; wrong for a solo dev on a public repo.
- **Shared deploy** = one `scripts/deploy-mobile.sh <artifact>` both platforms call; reads target host/user/path/name from the gitignored config, `scp`-replaces the file, verifies by size/checksum.
- **Symmetry**: both platforms expose `./scripts/build-<platform>.sh` for consistent muscle memory; the iOS one wraps fastlane.

### 4.2 The KMP seam (why iOS calls gradle)

The shared `MobileData.xcframework` is a **gradle** artifact both clients consume, differently:
- Android links `:shared:mobile-data` as a gradle project dependency → `assembleRelease` builds it transitively. Nothing special.
- iOS links a *prebuilt* `.xcframework`, so the iOS flow must invoke gradle first. This is **step 0 of the fastlane lane** — fastlane is good at ordered shell steps, so the gradle prerequisite lives naturally inside the lane. No third orchestration layer, no gradle-shells-out-to-fastlane inversion.

### 4.3 Release XCFramework + stable path

For a true *release* ipa the embedded KMP code must be release-optimized (`assembleMobileDataReleaseXCFramework`, `isStatic = true`). The XcodeGen spec dependency path is static, and local Xcode dev wants the *debug* variant (faster, debuggable). Resolution: **variant-neutral stable path**.

- `project.yml` dependency changes from
  `…/build/XCFrameworks/debug/MobileData.xcframework`
  → `…/build/XCFrameworks/MobileData.xcframework` (no variant subdir).
- Whoever generates the project populates that path first:
  - **Release lane** (fastlane) → builds the **release** variant, copies it to the stable path.
  - **Local dev** → a new `scripts/ios-setup.sh` builds the **debug** variant, copies it to the stable path, runs `xcodegen generate`. This replaces the current manual "gradle debug xcframework → xcodegen" dev step.
- The stable path lives under the already-gitignored `build/` tree.
- Doc impact: update `ios/CLAUDE.md` / the `ios-xcodebuild` rule note to point local devs at `scripts/ios-setup.sh`.

### 4.4 iOS signing & credential handling (no-leak guarantee)

The lane never stores, embeds, or reads any Apple credential or certificate. It signs purely with what already lives on the machine:

- **Certificate + private key** → stay in the **macOS Keychain**. Never copied into the repo, never read by the script. (Contrast `match`, which we explicitly avoid because it puts certs in a git repo.)
- **Provisioning profile** → Xcode auto-manages it in `~/Library/...`; `-allowProvisioningUpdates` lets Xcode refresh/create it using **Xcode's own signed-in account session** (Settings ▸ Accounts) — the script supplies no Apple ID password.
- **What the lane actually needs from config**: just `IOS_TEAM_ID` (passed as `DEVELOPMENT_TEAM`). `APPLE_ID` is **optional** — only used if we ever do App Store Connect auth (we don't), so it can be omitted entirely for the local ad-hoc flow.
- **Team id is not a secret** (it's embedded in every distributed `.ipa`); we still keep it in the gitignored config to honor "no personal info in git," but its exposure would reveal nothing sensitive.
- Net: committed code carries the public bundle id only; identity values come from gitignored config via `ENV`; the pre-commit scan (§6) is the backstop.

## 5. Config & secret files

| File | Committed? | Contents |
|------|-----------|----------|
| `android/keystore.properties` | ❌ gitignored | `storeFile`, `storePassword`, `keyAlias`, `keyPassword` |
| `android/keystore.properties.example` | ✅ | template with placeholder values + comments |
| `android/release.keystore` (`.jks`) | ❌ gitignored | the fresh keystore (generated once) |
| `ios/App/Local.xcconfig` | ❌ already gitignored | debug gateway url (unchanged) |
| `scripts/release.local.conf` | ❌ gitignored | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `IPA_NAME`, `APK_NAME`, `IOS_TEAM_ID` (required), `APPLE_ID` (optional — only for App Store Connect, unused here) |
| `scripts/release.local.conf.example` | ✅ | template + comments |
| `fastlane/Fastfile` | ✅ | the `ios adhoc` lane; all identity via `ENV[…]` |
| `fastlane/Appfile` | ✅ | `app_identifier "io.dev32.sentient"` (already public); `apple_id` / `team_id` via `ENV` |
| `Gemfile` / `Gemfile.lock` | ✅ | pins fastlane version (bundler) |
| `android/build.gradle.kts` | ✅ | `signingConfigs.release` reads `keystore.properties` **only if it exists** |

**Filename choice:** the deploy/identity config is `scripts/release.local.conf` (shell `key=value`, sourced by the scripts and exported into fastlane's ENV). Deliberately **not** named `.env` — fastlane auto-loads `.env`, and the project convention treats `.env` files as off-limits.

**Conditional Android signing** (so public builds still work):
```kotlin
val keystorePropsFile = rootProject.file("keystore.properties")
val hasRelease = keystorePropsFile.exists()
// signingConfigs.create("release") { ... } only when hasRelease
// release buildType: signingConfig = if (hasRelease) signingConfigs["release"] else null
```
Absent keystore → release build is unsigned (contributor case); present → signed. `build-android.sh` requires it and fails loudly if missing.

## 6. Public-repo safety net

- `.gitignore` entries for every gitignored file in §5 (`keystore.properties`, `release.keystore`, `scripts/release.local.conf`). `*.jks`/`*.keystore`/`*.p12` already broadly ignored under `ios/`; add equivalents at repo root / `android/`.
- Extend `scripts/secrets-content-scan.sh` to flag the new leak shapes: keystore passwords, `DEPLOY_HOST/USER/PATH` literals, `.jks` bytes, apple_id email. Wire it as a **pre-commit guard** (git hook) so personal info cannot be staged.
- `keytool` generates the keystore non-interactively; the chosen passwords are written **only** into the gitignored `keystore.properties` — never echoed to stdout or logs (honors the "never print secrets" rule).
- Deploy target host/user/path are read from config and **not** logged verbatim at INFO.

## 7. Verification matrix

Browser/Maestro E2E is **N/A** — this is dev tooling, not runtime app behavior; no UX/viewport surface changes. Verification is artifact-and-signature based, run against the real local toolchain.

| Case | Pre-state | Action | Expected artifact | Expected check |
|------|-----------|--------|-------------------|----------------|
| iOS happy (build-only) | configs present, cert in keychain | `./scripts/build-ios.sh` | `Sentient.ipa` produced, NOT uploaded | `EXPORT SUCCEEDED`; embedded profile = ad-hoc `io.dev32.sentient`, `get-task-allow=false`, 2 devices |
| iOS missing config | `release.local.conf` absent | `./scripts/build-ios.sh` | none | fails loudly, names the missing `.example` |
| iOS deploy (opt-in) | ipa built | `./scripts/build-ios.sh --deploy` | ipa on server | remote `IPA_NAME` replaced; local↔remote md5 match |
| Android happy (build-only) | keystore + props present | `./scripts/build-android.sh` | `Sentient.apk` produced, NOT uploaded | `apksigner verify` passes; signer = release keystore |
| Android no keystore | `keystore.properties` absent | `./scripts/build-android.sh` | none | fails loudly, names the `.example` |
| Android deploy (opt-in) | apk built | `./scripts/build-android.sh --deploy` | apk on server | remote `APK_NAME` replaced; local↔remote md5 match |
| Public-contributor build | no secrets at all | `./gradlew :android:assembleDebug` | debug apk | builds fine; no signing config required |
| Secret guard | personal value staged | `git commit` | blocked | pre-commit scan rejects, points at offending value |

## 8. Implementation slices

1. **Android release signing** — generate keystore (keytool); `keystore.properties(.example)`; conditional `signingConfigs.release` in `build.gradle.kts`; `.gitignore`. Verify: `apksigner verify` on `assembleRelease`.
2. **iOS stable-path + dev setup** — change `project.yml` dependency to stable path; `scripts/ios-setup.sh` (debug variant → path → xcodegen); update `ios/CLAUDE.md` note. Verify: local Xcode build still runs.
3. **iOS fastlane lane** — `Gemfile` (fastlane), `fastlane/Fastfile` (`ios adhoc`: gradle release xcframework → copy → xcodegen → gym ad-hoc + `-allowProvisioningUpdates`), `Appfile` via ENV. Verify: `Sentient.ipa` with ad-hoc profile.
4. **Shared deploy + wrappers** — `scripts/release.local.conf(.example)`; `scripts/deploy-mobile.sh`; `scripts/build-android.sh`, `scripts/build-ios.sh` (opt-in `--deploy`). Verify: both build-only and `--deploy` paths; md5 match on deploy.
5. **Safety net** — extend `secrets-content-scan.sh`; pre-commit hook. Verify: staging a fake secret is blocked.
6. **Docs** — make the scripts discoverable so we (and future contributors) know they exist:
   - Root `CLAUDE.md` "## Commands" — add the `build-ios.sh` / `build-android.sh` / `--deploy` entries.
   - Root `README.md` (or a new `docs/mobile-release.md`) — short "Building & releasing the mobile apps" section: prerequisites (keychain cert, keystore, `release.local.conf`), the two commands, opt-in deploy, adding a device.
   - `ios/CLAUDE.md` + `ios-xcodebuild` rule note — point local iOS dev at `scripts/ios-setup.sh` (the new stable-path setup) instead of the old manual gradle+xcodegen step.
   - `android/CLAUDE.md` — note release signing now exists and how to provision the gitignored keystore.
   - `.example` files self-document via inline comments.
   Verify: a fresh reader can find and run the flow from the docs alone.

## 9. Risks / open items

- **fastlane `gym` automatic signing + `-allowProvisioningUpdates`**: must reproduce the manual archive/export exactly (team via `DEVELOPMENT_TEAM`, `CODE_SIGN_STYLE=Automatic`, `export_method: ad-hoc`). Mitigation: pass through `xcargs` / `export_options`; the manual run is the reference. Note `ad-hoc` is the deprecated alias of `release-testing` in current Xcode — both still accepted; pick one and pin it.
- **Stable-path migration** breaks any local checkout that hasn't run `scripts/ios-setup.sh`. Mitigation: doc note + the setup script is the single documented entry for local iOS dev.
- **New device** for the ad-hoc profile still requires adding the UDID in the Apple portal + a profile refresh (`-allowProvisioningUpdates` picks it up on next build). Out of script scope; documented.
- **Ruby/bundler dependency** introduced for iOS only. Acceptable: fastlane is the iOS standard and Android stays pure-gradle.
