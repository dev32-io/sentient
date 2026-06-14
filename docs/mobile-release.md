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
4. **Tools:** `brew install xcodegen`; `bundle install` (fastlane); a JDK (`keytool` for the keystore) + the Android SDK (for `gradle`). `apksigner` is optional — only to manually verify an apk's signature.

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
refreshes the profile automatically on the next `./scripts/build-ios.sh` (requires step 2's
`IOS_TEAM_ID` in `scripts/release.local.conf`).

## Versions

Bump manually and keep in lockstep: `ios/project.yml` (`CFBundleShortVersionString`),
`android/build.gradle.kts` (`versionName`/`versionCode`), and the `shared/mobile-*` module versions.
The scripts do not bump versions.
