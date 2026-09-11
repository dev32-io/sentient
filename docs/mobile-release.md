# Building & Releasing the Mobile Apps

Local, secret-driven build scripts. No CI machine. Artifacts are signed on your
Mac from secrets that never enter this (public) repo. See the design spec:
`docs/superpowers/specs/2026-06-13-mobile-build-release-tooling-design.md`.

iOS is the active mobile release target. Android is deprecated; its commands
below are retained for legacy maintenance, not as a prerequisite for iOS releases.

## One-time setup

1. **Android keystore:** `./scripts/android-make-keystore.sh`
   → creates `android/release.keystore` + `android/keystore.properties` (both gitignored). Back them up.
2. **Deploy + iOS team config:** `cp scripts/release.local.conf.example scripts/release.local.conf`
   then fill `DEPLOY_HOST`, `DEPLOY_USER`, `RELEASES_PATH`, and `IOS_TEAM_ID`.
3. **iOS signing cert:** sign your Apple ID into Xcode ▸ Settings ▸ Accounts. The cert lives in
   your macOS Keychain; the lane never copies it. Devices must be registered under the ad-hoc profile.
4. **Tools:** `brew install xcodegen`; `bundle install` (fastlane); a JDK (`keytool` for the keystore) + the Android SDK (for `gradle`). `apksigner` is optional — only to manually verify an apk's signature.

## Build

```bash
./scripts/build-android.sh           # → android/build/outputs/apk/release/android-release.apk
./scripts/build-ios.sh               # → ios/build/ipa/SentientApp.ipa
```

Add `--deploy` to upload the artifact as the platform's `latest` file, verify it by MD5,
and refresh the remote `manifest.json` while preserving the other platform's entry:

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
refreshes the profile automatically on the next `./scripts/build-ios.sh` (requires step 2's
`IOS_TEAM_ID` in `scripts/release.local.conf`).

## Versions

Bump app release versions manually in `ios/project.yml`
(`CFBundleShortVersionString`/`CFBundleVersion`) and `android/build.gradle.kts`
(`versionName`/`versionCode`). Keep Android and iOS app versions aligned for a joint release.
The shared `mobile-sdk`/`mobile-data` module versions follow their own source track and need not
numerically match the app release. An iOS-only release leaves the deprecated Android version
unchanged. Regenerate `ios/App/Info.plist` from `ios/project.yml` with XcodeGen; do not hand-edit
the generated plist or commit generated Xcode project/scheme state. The scripts do not bump versions.

The design-refresh release uses iOS **1.5.0 (build 12)** and shared mobile SDK/data **0.7.0**.
Its gateway/WebUI counterparts are **1.16.0 / 0.8.0**. These are source version bumps,
not evidence that signed artifacts have been built or deployed.
