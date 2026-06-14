# Mobile Build/Release Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two symmetric one-command entry points (`scripts/build-ios.sh`, `scripts/build-android.sh`) that produce a signed, installable artifact from local secrets and optionally (`--deploy`) scp it to the file server — with zero personal info committed to this public repo.

**Architecture:** Android = pure gradle (`assembleRelease`) signed via a `signingConfig` reading a gitignored `keystore.properties`. iOS = a fastlane `gym` lane that first builds the KMP release XCFramework (gradle), copies it to a variant-neutral stable path, runs `xcodegen`, then archives + exports ad-hoc using the **local macOS Keychain identity** + Xcode auto-managed profiles (no cert/credential in repo). A shared `deploy-mobile.sh` scp-replaces the artifact. All identity/secret values live in gitignored files (`keystore.properties`, `scripts/release.local.conf`) with committed `.example` templates; lefthook + an extended content-scan block accidental commits.

**Tech Stack:** bash, Gradle (Kotlin DSL) + AGP, XcodeGen, `xcodebuild`/`gym`, fastlane (Ruby/bundler), keytool, lefthook.

**Reference spec:** `docs/superpowers/specs/2026-06-13-mobile-build-release-tooling-design.md`
**Branch:** `feature/mobile-build-release-tooling` (on latest develop `6852a55`).

---

## File Structure

**Create:**
- `scripts/android-make-keystore.sh` — one-time keystore generator; writes `android/keystore.properties`, never echoes the password.
- `android/keystore.properties.example` — template (committed).
- `scripts/ios-gen-project.sh` — ensures `Local.xcconfig` exists, runs `xcodegen generate` (DRY helper for both dev + release flows).
- `scripts/ios-setup.sh` — local-dev iOS setup: build **debug** XCFramework → stable path → `ios-gen-project.sh`.
- `Gemfile` — pins fastlane (committed; `Gemfile.lock` committed after `bundle install`).
- `fastlane/Fastfile` — the `ios adhoc` lane (identity via ENV).
- `fastlane/Appfile` — `app_identifier` (public) + ENV-driven `apple_id`/`team_id`.
- `scripts/release.local.conf.example` — deploy + iOS team template (committed).
- `scripts/deploy-mobile.sh` — shared scp + md5-verify.
- `scripts/build-android.sh`, `scripts/build-ios.sh` — entry wrappers (`--deploy` opt-in).
- `docs/mobile-release.md` — how-to.

**Modify:**
- `.gitignore` — ignore the new secret/config files.
- `lefthook.yml` — extend `secrets-guard` filename block.
- `scripts/secrets-content-scan.sh` — add a keystore-password backstop pattern.
- `android/build.gradle.kts` — conditional `signingConfigs.release`.
- `ios/project.yml` — XCFramework dep → stable path (×2).
- `CLAUDE.md` (root) — Commands section.
- `ios/CLAUDE.md`, `android/CLAUDE.md` — note the new flows.
- `.claude/rules/ios/ios-xcodebuild.md` — point local dev at `scripts/ios-setup.sh`.

**Gitignored secrets (created at runtime, never committed):** `android/release.keystore`, `android/keystore.properties`, `scripts/release.local.conf`, `ios/App/Local.xcconfig`.

> **Note on verification:** this is build tooling — there are no unit tests. "Verify" steps run real toolchain commands (`apksigner verify`, profile decode, md5 match). Steps that need the actual signing cert / file server are marked **(needs local secrets)**; run them on Kevin's machine.

---

## Task 1: Secret-ignore guards (do FIRST so later-created secrets are already protected)

**Files:**
- Modify: `.gitignore`
- Modify: `lefthook.yml`
- Modify: `scripts/secrets-content-scan.sh`

- [ ] **Step 1: Add ignore entries.** Append to `.gitignore` (root):

```gitignore

# Mobile release signing + deploy config — NEVER commit (templates use *.example)
android/release.keystore
*.jks
android/keystore.properties
scripts/release.local.conf
fastlane/report.xml
fastlane/Preview.html
```

(`**/build/` and `local.properties` are already ignored, covering the iOS stable path and the SDK file.)

- [ ] **Step 2: Extend the lefthook filename block.** In `lefthook.yml`, in `pre-commit › secrets-guard › run`, extend the first `grep -iE` alternation to also block the two custom config files by name. Replace:

```
          | grep -iE '\.env($|\..*)$|\.env\.local$|(^|/)secrets?\.|credentials|\.pem$|\.key$|\.p12$|\.pfx$|\.jks$|(^|/)keys\.yaml$|(^|/)state\.yaml$' \
```

with:

```
          | grep -iE '\.env($|\..*)$|\.env\.local$|(^|/)secrets?\.|credentials|\.pem$|\.key$|\.p12$|\.pfx$|\.jks$|(^|/)keys\.yaml$|(^|/)state\.yaml$|(^|/)keystore\.properties$|(^|/)release\.local\.conf$' \
```

(The `$` anchors mean `keystore.properties.example` and `release.local.conf.example` are NOT blocked.)

- [ ] **Step 3: Add a content-scan backstop pattern.** In `scripts/secrets-content-scan.sh`, add to the `PATTERNS` array. The pattern is intentionally narrow — only a real base64-shaped value (≥16 chars) trips it, so `storePassword=$PASS` (variable refs in our own scripts/docs) and `FAKE_…` placeholders do NOT false-positive (and `grep -v "FAKE_"` already runs):

```bash
  # Android keystore password committed as a real base64-ish literal (≥16 chars).
  # Narrow on purpose: $VAR refs and FAKE_ placeholders must NOT match. The real
  # keystore.properties is gitignored + filename-blocked; this is only a force-add backstop.
  '(store|key)Password[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{16,}={0,2}([[:space:]]|$)'
```

- [ ] **Step 4: Verify both guards fire.** Run:

```bash
# (a) filename block — staging the real secret file by name:
echo 'storePassword=FAKE_x' > android/keystore.properties
git add -f android/keystore.properties
lefthook run pre-commit 2>&1 | grep -iE "BLOCKED.*keystore" && echo "✓ filename guard blocks keystore.properties"
git reset -q HEAD android/keystore.properties && rm -f android/keystore.properties

# (b) content scan — a real base64-shaped password in an otherwise-allowed file:
echo 'storePassword=AbCdEf0123456789ghIJ=' > /tmp/leaky.conf && cp /tmp/leaky.conf ./leaky.conf
git add -f ./leaky.conf
scripts/secrets-content-scan.sh 2>&1 | grep -iE "secret|Password" && echo "✓ content scan flags base64 password"
git reset -q HEAD ./leaky.conf && rm -f ./leaky.conf /tmp/leaky.conf
```

Expected: (a) lefthook `secrets-guard` prints `🚨 BLOCKED` listing `keystore.properties`; (b) the content scan exits non-zero and flags the password line. Confirm a real `$PASS`-style line is NOT flagged: `printf '+storePassword=$PASS\n' | grep -E '(store\|key)Password[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{16,}' || echo "✓ \$PASS ref not flagged"`.

- [ ] **Step 5: Commit.**

```bash
git add .gitignore lefthook.yml scripts/secrets-content-scan.sh
git commit -m "chore(mobile): gitignore + pre-commit guards for release signing/deploy secrets"
```

---

## Task 2: Android release signing

**Files:**
- Create: `scripts/android-make-keystore.sh`
- Create: `android/keystore.properties.example`
- Modify: `android/build.gradle.kts`

- [ ] **Step 1: Create the keystore generator.** Create `scripts/android-make-keystore.sh`:

```bash
#!/usr/bin/env bash
# One-time: generate the Android release keystore + write android/keystore.properties.
# The password is random and printed NOWHERE — it lives only in the gitignored props file.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
KS="$REPO/android/release.keystore"
PROPS="$REPO/android/keystore.properties"
ALIAS="sentient-release"

[ -f "$KS" ] && { echo "ERROR: $KS already exists — refusing to overwrite (would break update continuity)."; exit 1; }
command -v keytool >/dev/null || { echo "ERROR: keytool not found (install a JDK)."; exit 1; }

PASS="$(openssl rand -base64 24)"
keytool -genkeypair -v -keystore "$KS" -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 -storetype PKCS12 \
  -dname "CN=Sentient, OU=Mobile, O=Sentient, C=US" \
  -storepass "$PASS" -keypass "$PASS" >/dev/null

umask 077
cat > "$PROPS" <<EOF
storeFile=release.keystore
storePassword=$PASS
keyAlias=$ALIAS
keyPassword=$PASS
EOF
chmod 600 "$PROPS"
echo "✓ created android/release.keystore + android/keystore.properties (both gitignored)."
echo "  Back these up somewhere safe — losing them means sideloaded updates won't install over the old app."
```

```bash
chmod +x scripts/android-make-keystore.sh
```

- [ ] **Step 2: Create the example template.** Create `android/keystore.properties.example`:

```properties
# Copy to android/keystore.properties (gitignored), OR just run scripts/android-make-keystore.sh
# which generates the keystore and writes this file for you.
# storeFile is resolved relative to the android/ module dir.
storeFile=release.keystore
storePassword=FAKE_replace_me
keyAlias=sentient-release
keyPassword=FAKE_replace_me
```

- [ ] **Step 3: Wire conditional signing in gradle.** In `android/build.gradle.kts`, the file already has `import java.util.Properties` at the top. Inside the `android { … }` block, immediately after the opening line `android {` and before `namespace = …`, add:

```kotlin
    // Release signing — sourced from android/keystore.properties (gitignored). Absent →
    // release stays unsigned so a public-repo contributor can still build. Present → signed.
    // Generate with scripts/android-make-keystore.sh.
    val keystorePropsFile = file("keystore.properties")
    val hasReleaseSigning = keystorePropsFile.exists()
    val keystoreProps = Properties().apply {
        if (hasReleaseSigning) keystorePropsFile.inputStream().use { load(it) }
    }
    if (hasReleaseSigning) {
        signingConfigs {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }
```

Then in the existing `buildTypes { getByName("release") { … } }` block, add as the first line inside `getByName("release") {`:

```kotlin
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
```

- [ ] **Step 4: Generate the keystore (needs local machine).** Run:

```bash
./scripts/android-make-keystore.sh
ls -l android/release.keystore android/keystore.properties
git check-ignore android/release.keystore android/keystore.properties   # both must print (ignored)
```

Expected: both files exist; `git check-ignore` lists both (confirming Task 1's ignores cover them).

- [ ] **Step 5: Build + verify the signed apk (needs local machine).** Run:

```bash
./gradlew :android:assembleRelease
APK=android/build/outputs/apk/release/android-release.apk
ls -l "$APK"
"$(dirname "$(command -v adb 2>/dev/null || echo /opt/homebrew/bin)")/apksigner" verify --print-certs "$APK" 2>/dev/null \
  || "$ANDROID_HOME"/build-tools/*/apksigner verify --print-certs "$APK"
```

Expected: `android-release.apk` exists; `apksigner verify` prints `Verified using v2/v3 scheme: true` and a `CN=Sentient` signer. (If `apksigner` isn't on PATH, it's under `$ANDROID_HOME/build-tools/<ver>/`.)

- [ ] **Step 6: Commit (code + template only — keystore/props are gitignored).**

```bash
git add scripts/android-make-keystore.sh android/keystore.properties.example android/build.gradle.kts
git status --short   # MUST NOT list android/release.keystore or android/keystore.properties
git commit -m "feat(android): release signing config from gitignored keystore.properties"
```

---

## Task 3: iOS stable-path migration (so dev + release share one XCFramework path)

**Files:**
- Modify: `ios/project.yml`
- Create: `scripts/ios-gen-project.sh`
- Create: `scripts/ios-setup.sh`

- [ ] **Step 1: Point the spec at the variant-neutral path.** In `ios/project.yml` there are **two** lines reading:

```
      - framework: ../shared/mobile-data/build/XCFrameworks/debug/MobileData.xcframework
```

Change **both** (the `SentientApp` target dep and the `SentientAppTests` dep) to drop the `debug/` segment:

```
      - framework: ../shared/mobile-data/build/XCFrameworks/MobileData.xcframework
```

- [ ] **Step 2: Create the project-gen helper.** Create `scripts/ios-gen-project.sh`:

```bash
#!/usr/bin/env bash
# Ensure the gitignored Local.xcconfig exists (xcodegen validation requires it),
# then regenerate the Xcode project from the spec. Used by both ios-setup.sh (dev)
# and the fastlane release lane.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LX="$REPO/ios/App/Local.xcconfig"
[ -f "$LX" ] || cp "$REPO/ios/App/Local.xcconfig.example" "$LX"
command -v xcodegen >/dev/null || { echo "ERROR: xcodegen not installed (brew install xcodegen)."; exit 1; }
( cd "$REPO/ios" && xcodegen generate )
```

```bash
chmod +x scripts/ios-gen-project.sh
```

- [ ] **Step 3: Create the local-dev setup script.** Create `scripts/ios-setup.sh`:

```bash
#!/usr/bin/env bash
# Local iOS dev setup: build the DEBUG KMP XCFramework, place it at the stable
# variant-neutral path the spec references, then generate the Xcode project.
# Run this before opening ios/SentientApp.xcodeproj.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
( cd "$REPO" && ./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework )
DST="$REPO/shared/mobile-data/build/XCFrameworks"
rm -rf "$DST/MobileData.xcframework"
cp -R "$DST/debug/MobileData.xcframework" "$DST/MobileData.xcframework"
"$REPO/scripts/ios-gen-project.sh"
echo "✓ iOS project ready (debug XCFramework at stable path). Open ios/SentientApp.xcodeproj."
```

```bash
chmod +x scripts/ios-setup.sh
```

- [ ] **Step 4: Verify local dev still works (needs local machine).** Run:

```bash
./scripts/ios-setup.sh
ls -d shared/mobile-data/build/XCFrameworks/MobileData.xcframework   # stable path populated
ls -d ios/SentientApp.xcodeproj                                      # project generated
xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -3
```

Expected: stable path + `.xcodeproj` exist; the simulator build ends with `** BUILD SUCCEEDED **` (signing disabled — just proves the stable-path link compiles).

- [ ] **Step 5: Commit (project.yml + scripts; generated project is gitignored).**

```bash
git add ios/project.yml scripts/ios-gen-project.sh scripts/ios-setup.sh
git commit -m "refactor(ios): variant-neutral XCFramework stable path + dev setup scripts"
```

---

## Task 4: iOS fastlane ad-hoc lane

**Files:**
- Create: `Gemfile`
- Create: `fastlane/Fastfile`
- Create: `fastlane/Appfile`

- [ ] **Step 1: Create the Gemfile.** Create `Gemfile` (repo root):

```ruby
source "https://rubygems.org"

gem "fastlane"
```

- [ ] **Step 2: Install fastlane + lock the version (needs local machine).** Run:

```bash
bundle install
ls Gemfile.lock && bundle exec fastlane --version | tail -2
```

Expected: `Gemfile.lock` created; fastlane version prints.

- [ ] **Step 3: Create the Appfile.** Create `fastlane/Appfile`:

```ruby
# Identity comes from ENV (set by scripts/build-ios.sh ← scripts/release.local.conf).
# Nothing personal is committed here: the bundle id is already public in project.yml.
app_identifier "io.dev32.sentient"
team_id(ENV["IOS_TEAM_ID"]) if ENV["IOS_TEAM_ID"]
apple_id(ENV["APPLE_ID"]) if ENV["APPLE_ID"]   # optional; unused for local ad-hoc
```

- [ ] **Step 4: Create the Fastfile.** Create `fastlane/Fastfile`:

```ruby
default_platform(:ios)

REPO = File.expand_path("..", __dir__) # fastlane/ -> repo root

platform :ios do
  desc "Build a signed ad-hoc .ipa using the local Keychain identity + Xcode auto profiles"
  lane :adhoc do
    team_id = ENV.fetch("IOS_TEAM_ID") # required; raises with a clear message if absent

    # Step 0: build the RELEASE KMP XCFramework (gradle owns the shared code)
    sh("cd #{REPO.shellescape} && ./gradlew :shared:mobile-data:assembleMobileDataReleaseXCFramework")

    # Step 1: place the release XCFramework at the variant-neutral stable path
    xcf_dir = "#{REPO}/shared/mobile-data/build/XCFrameworks"
    sh("rm -rf #{xcf_dir.shellescape}/MobileData.xcframework")
    sh("cp -R #{xcf_dir.shellescape}/release/MobileData.xcframework #{xcf_dir.shellescape}/MobileData.xcframework")

    # Step 2: ensure Local.xcconfig + regenerate the project from the spec
    sh("#{REPO.shellescape}/scripts/ios-gen-project.sh")

    # Step 3: archive + export ad-hoc. Signs with the cert ALREADY in the Keychain;
    # -allowProvisioningUpdates lets Xcode refresh the profile via its own account session.
    build_app(
      project: "#{REPO}/ios/SentientApp.xcodeproj",
      scheme: "SentientApp",
      configuration: "Release",
      export_method: "ad-hoc",
      archive_path: "#{REPO}/ios/build/SentientApp.xcarchive",
      output_directory: "#{REPO}/ios/build/ipa",
      output_name: "SentientApp.ipa",
      xcargs: "-allowProvisioningUpdates DEVELOPMENT_TEAM=#{team_id} CODE_SIGN_STYLE=Automatic",
      export_options: {
        signingStyle: "automatic",
        teamID: team_id,
        method: "ad-hoc",
      },
    )
  end
end
```

- [ ] **Step 5: Smoke the lane (needs local machine + Keychain cert).** Run (requires `IOS_TEAM_ID`; use the real team for a true run, or just confirm the missing-env failure first):

```bash
# (a) fails loudly without the team id:
( cd "$(git rev-parse --show-toplevel)" && bundle exec fastlane ios adhoc ) 2>&1 | grep -i "IOS_TEAM_ID" && echo "✓ fails loudly without team id"
# (b) real run:
IOS_TEAM_ID=PFL93YDS3B bash -c 'cd "$(git rev-parse --show-toplevel)" && bundle exec fastlane ios adhoc'
IPA="$(git rev-parse --show-toplevel)/ios/build/ipa/SentientApp.ipa"
ls -l "$IPA"
unzip -p "$IPA" "Payload/SentientApp.app/embedded.mobileprovision" | security cms -D 2>/dev/null \
  | /usr/libexec/PlistBuddy -c 'Print :Name' /dev/stdin 2>/dev/null
```

Expected: (a) raises a `KeyError`/`IOS_TEAM_ID` message; (b) `** EXPORT SUCCEEDED **`, `SentientApp.ipa` produced, embedded profile name = `iOS Team Ad Hoc Provisioning Profile: io.dev32.sentient`.

- [ ] **Step 6: Commit.**

```bash
git add Gemfile Gemfile.lock fastlane/Appfile fastlane/Fastfile
git commit -m "feat(ios): fastlane ad-hoc lane (local-keychain signing, KMP release xcframework step 0)"
```

---

## Task 5: Shared config, deploy, and entry wrappers

**Files:**
- Create: `scripts/release.local.conf.example`
- Create: `scripts/deploy-mobile.sh`
- Create: `scripts/build-android.sh`
- Create: `scripts/build-ios.sh`

- [ ] **Step 1: Create the config template.** Create `scripts/release.local.conf.example`:

```bash
# Copy to scripts/release.local.conf (gitignored). Drives deploy + iOS signing identity.
# Sourced by build-ios.sh, build-android.sh, deploy-mobile.sh. NONE of this is committed.
DEPLOY_HOST=your-fileserver.local          # ssh host for the file server
DEPLOY_USER=youruser                       # ssh user
DEPLOY_PATH=/home/youruser/path/to/files   # remote dir holding the artifacts
IPA_NAME=Sentient.ipa                      # remote filename for the .ipa
APK_NAME=Sentient.apk                      # remote filename for the .apk
IOS_TEAM_ID=YOURTEAMID                     # Apple Developer team (DEVELOPMENT_TEAM); not secret, kept out of git
# APPLE_ID=you@example.com                 # OPTIONAL — only for App Store Connect (unused here)
```

- [ ] **Step 2: Create the deploy script.** Create `scripts/deploy-mobile.sh`:

```bash
#!/usr/bin/env bash
# scp an artifact to the file server (replacing the prior one) and verify by md5.
# Target host/user/path + remote names come from the gitignored release.local.conf.
set -euo pipefail
ARTIFACT="${1:?usage: deploy-mobile.sh <path-to-.ipa-or-.apk>}"
[ -f "$ARTIFACT" ] || { echo "ERROR: artifact not found: $ARTIFACT"; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$DIR/release.local.conf"
[ -f "$CONF" ] || { echo "ERROR: $CONF missing — copy scripts/release.local.conf.example and fill it."; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
: "${DEPLOY_HOST:?set DEPLOY_HOST in release.local.conf}" "${DEPLOY_USER:?}" "${DEPLOY_PATH:?}"

case "$ARTIFACT" in
  *.ipa) NAME="${IPA_NAME:?set IPA_NAME in release.local.conf}" ;;
  *.apk) NAME="${APK_NAME:?set APK_NAME in release.local.conf}" ;;
  *) echo "ERROR: unknown artifact type (expect .ipa/.apk): $ARTIFACT"; exit 1 ;;
esac

scp -o ConnectTimeout=10 "$ARTIFACT" "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/${NAME}"
LOCAL_MD5="$(md5 -q "$ARTIFACT" 2>/dev/null || md5sum "$ARTIFACT" | cut -d' ' -f1)"
REMOTE_MD5="$(ssh -o ConnectTimeout=10 "${DEPLOY_USER}@${DEPLOY_HOST}" "md5sum '${DEPLOY_PATH}/${NAME}'" | cut -d' ' -f1)"
if [ "$LOCAL_MD5" = "$REMOTE_MD5" ]; then
  echo "✓ deployed ${NAME} (md5 ${LOCAL_MD5})"
else
  echo "✗ md5 mismatch (local ${LOCAL_MD5} / remote ${REMOTE_MD5})"; exit 1
fi
```

```bash
chmod +x scripts/deploy-mobile.sh
```

- [ ] **Step 3: Create the Android wrapper.** Create `scripts/build-android.sh`:

```bash
#!/usr/bin/env bash
# Build the signed Android release apk; deploy is opt-in (--deploy).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY=0; [ "${1:-}" = "--deploy" ] && DEPLOY=1

[ -f "$REPO/android/keystore.properties" ] || {
  echo "ERROR: android/keystore.properties missing — run scripts/android-make-keystore.sh first."; exit 1; }

( cd "$REPO" && ./gradlew :android:assembleRelease )

APK="$REPO/android/build/outputs/apk/release/android-release.apk"
[ -f "$APK" ] || { echo "ERROR: apk not found at $APK"; ls -l "$REPO/android/build/outputs/apk/release/" || true; exit 1; }
echo "✓ built $APK"

[ "$DEPLOY" = "1" ] && "$REPO/scripts/deploy-mobile.sh" "$APK"
```

```bash
chmod +x scripts/build-android.sh
```

- [ ] **Step 4: Create the iOS wrapper.** Create `scripts/build-ios.sh`:

```bash
#!/usr/bin/env bash
# Build the signed ad-hoc iOS ipa via fastlane; deploy is opt-in (--deploy).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY=0; [ "${1:-}" = "--deploy" ] && DEPLOY=1

command -v xcodegen >/dev/null || { echo "ERROR: xcodegen not installed (brew install xcodegen)."; exit 1; }
CONF="$REPO/scripts/release.local.conf"
[ -f "$CONF" ] || { echo "ERROR: $CONF missing — copy scripts/release.local.conf.example and set IOS_TEAM_ID."; exit 1; }
# shellcheck disable=SC1090
source "$CONF"
: "${IOS_TEAM_ID:?set IOS_TEAM_ID in scripts/release.local.conf}"
export IOS_TEAM_ID
[ -n "${APPLE_ID:-}" ] && export APPLE_ID

( cd "$REPO" && bundle exec fastlane ios adhoc )

IPA="$REPO/ios/build/ipa/SentientApp.ipa"
[ -f "$IPA" ] || { echo "ERROR: ipa not produced at $IPA"; exit 1; }
echo "✓ built $IPA"

[ "$DEPLOY" = "1" ] && "$REPO/scripts/deploy-mobile.sh" "$IPA"
```

```bash
chmod +x scripts/build-ios.sh
```

- [ ] **Step 5: Verify build-only + missing-config paths (needs local machine).** Run:

```bash
# missing config fails loudly:
mv scripts/release.local.conf scripts/release.local.conf.bak 2>/dev/null || true
./scripts/build-ios.sh 2>&1 | grep -i "release.local.conf missing" && echo "✓ ios fails loudly"
# set up real config, then build-only (no deploy):
cp scripts/release.local.conf.example scripts/release.local.conf   # then edit real values
# ...edit scripts/release.local.conf with real DEPLOY_* + IOS_TEAM_ID...
./scripts/build-android.sh            # build-only, must NOT upload
./scripts/build-ios.sh                # build-only, must NOT upload
```

Expected: missing-config run prints the error; build-only runs produce `Sentient`-bound artifacts locally and print `✓ built …` with **no** scp.

- [ ] **Step 6: Verify opt-in deploy (needs local machine + file server).** Run:

```bash
./scripts/build-android.sh --deploy
./scripts/build-ios.sh --deploy
```

Expected: each ends with `✓ deployed Sentient.apk (md5 …)` / `✓ deployed Sentient.ipa (md5 …)` — local↔remote md5 match.

- [ ] **Step 7: Commit (scripts + template; real conf is gitignored).**

```bash
git add scripts/release.local.conf.example scripts/deploy-mobile.sh scripts/build-android.sh scripts/build-ios.sh
git status --short   # MUST NOT list scripts/release.local.conf
git commit -m "feat(mobile): build-ios/build-android entry wrappers + shared scp deploy (opt-in --deploy)"
```

---

## Task 6: Documentation (make the scripts discoverable)

**Files:**
- Create: `docs/mobile-release.md`
- Modify: `CLAUDE.md` (root), `ios/CLAUDE.md`, `android/CLAUDE.md`, `.claude/rules/ios/ios-xcodebuild.md`

- [ ] **Step 1: Write the how-to doc.** Create `docs/mobile-release.md`:

```markdown
# Building & Releasing the Mobile Apps

Local, secret-driven build scripts. No CI machine. Artifacts are signed on your
Mac from secrets that never enter this (public) repo. See the design spec:
`docs/superpowers/specs/2026-06-13-mobile-build-release-tooling-design.md`.

## One-time setup

1. **Android keystore:** `./scripts/android-make-keystore.sh`
   → creates `android/release.keystore` + `android/keystore.properties` (both gitignored). Back them up.
2. **Deploy + iOS team config:** `cp scripts/release.local.conf.example scripts/release.local.conf`
   then fill `DEPLOY_HOST/USER/PATH`, `IPA_NAME`, `APK_NAME`, `IOS_TEAM_ID`.
3. **iOS signing cert:** sign your Apple ID into Xcode ▸ Settings ▸ Accounts. The cert lives in
   your macOS Keychain; the lane never copies it. Devices must be registered under the ad-hoc profile.
4. **Tools:** `brew install xcodegen`; `bundle install` (fastlane); a JDK (keytool) + Android SDK (apksigner).

## Build

```bash
./scripts/build-android.sh           # → android/build/outputs/apk/release/android-release.apk
./scripts/build-ios.sh               # → ios/build/ipa/SentientApp.ipa
```

Add `--deploy` to scp the artifact to the file server (replacing the prior one), verified by md5:

```bash
./scripts/build-ios.sh --deploy
./scripts/build-android.sh --deploy
```

## Local iOS development (running in Xcode, not releasing)

```bash
./scripts/ios-setup.sh               # debug XCFramework → stable path → xcodegen
open ios/SentientApp.xcodeproj
```

## Adding a device (ad-hoc)

Register the UDID in the Apple Developer portal, then rebuild — `-allowProvisioningUpdates`
refreshes the profile automatically on the next `./scripts/build-ios.sh`.

## Versions

Bump manually and keep in lockstep: `ios/project.yml` (`CFBundleShortVersionString`),
`android/build.gradle.kts` (`versionName`/`versionCode`), and the `shared/mobile-*` module versions.
The scripts do not bump versions.
```

- [ ] **Step 2: Add the commands to root `CLAUDE.md`.** In `CLAUDE.md`, find the `## Commands` fenced block ending with `bun run ci …`. Immediately after that closing fence, add:

```markdown

## Mobile build/release

    ./scripts/ios-setup.sh           — local iOS dev: debug XCFramework + generate project
    ./scripts/build-android.sh       — signed release apk (add --deploy to scp to the file server)
    ./scripts/build-ios.sh           — signed ad-hoc ipa  (add --deploy to scp to the file server)

See `docs/mobile-release.md` for one-time setup (keystore, `scripts/release.local.conf`, signing).
```

- [ ] **Step 3: Update `ios/CLAUDE.md`.** Append:

```markdown

## Build

Local dev: `./scripts/ios-setup.sh` (builds the debug KMP XCFramework to the stable path +
generates the project), then open `ios/SentientApp.xcodeproj`. Release ipa: `./scripts/build-ios.sh`.
See `docs/mobile-release.md`.
```

- [ ] **Step 4: Update `android/CLAUDE.md`.** Append:

```markdown

## Build

Release signing reads the gitignored `android/keystore.properties` (generate via
`scripts/android-make-keystore.sh`); absent → release is unsigned so contributors can still build.
Signed apk: `./scripts/build-android.sh`. See `docs/mobile-release.md`.
```

- [ ] **Step 5: Update the xcodebuild rule.** In `.claude/rules/ios/ios-xcodebuild.md`, under `## \`xcodebuild\` is the build, not the GUI`, the bullet says "Regenerate the project before building so it matches the spec." Append a sibling bullet:

```markdown
- Local dev regenerates via `scripts/ios-setup.sh` (debug KMP XCFramework → the variant-neutral stable path `shared/mobile-data/build/XCFrameworks/MobileData.xcframework` → `xcodegen`). The release ipa is built by `scripts/build-ios.sh` (fastlane lane builds the *release* XCFramework into the same path).
```

- [ ] **Step 6: Commit.**

```bash
git add docs/mobile-release.md CLAUDE.md ios/CLAUDE.md android/CLAUDE.md .claude/rules/ios/ios-xcodebuild.md
git commit -m "docs(mobile): document build/release scripts (CLAUDE.md, README how-to, ios-xcodebuild rule)"
```

---

## Final verification (full matrix from the spec)

Run after all tasks (needs local machine + file server). Each row maps to a spec §7 case:

- [ ] iOS build-only → `Sentient.ipa`, NOT uploaded; embedded ad-hoc profile, 2 devices.
- [ ] iOS missing `release.local.conf` → fails loudly naming the `.example`.
- [ ] iOS `--deploy` → remote `IPA_NAME` replaced, md5 match.
- [ ] Android build-only → `android-release.apk`, NOT uploaded; `apksigner verify` passes.
- [ ] Android missing `keystore.properties` → fails loudly.
- [ ] Android `--deploy` → remote `APK_NAME` replaced, md5 match.
- [ ] Public-contributor `./gradlew :android:assembleDebug` (no secrets) → builds fine.
- [ ] Secret guard → staging `keystore.properties` / `release.local.conf` / a `storePassword=` line is blocked at commit.
- [ ] `git status` after all commits lists no secret files; `git log` shows no personal host/team/email/keystore.

---

## Notes / gotchas

- **`ad-hoc` export-method warning:** current Xcode prints `Command line name "ad-hoc" is deprecated. Use "release-testing"`. It still works. If a future Xcode rejects it, switch both `export_method:` and `export_options.method:` in the Fastfile to `release-testing`.
- **PKCS12 keystore:** `storePassword == keyPassword` by design (PKCS12 convention); the generator sets them equal.
- **apk module name:** AGP names the artifact after the gradle module (`:android`) → `android-release.apk`. If the module is ever renamed, update `build-android.sh` + this plan.
- **Stable-path migration:** any existing local checkout must run `scripts/ios-setup.sh` once after pulling — the old `debug/` path is no longer referenced by the spec.
- **fastlane run dir:** the lane is invoked from the repo root (`Gemfile` + `fastlane/` live there); all lane paths are absolute via `REPO`.
