---
description: Xcode build -- .xcconfig settings, shared schemes, xcodebuild for CI, SPM preferred.
paths:
  - "ios/**"
---

# Xcode Build Conventions

Pull settings out of the `.xcodeproj` blob so the build diffs cleanly and reproduces on CI.

## Build settings in `.xcconfig`
- ALL build settings (deployment target, Swift version, defines, signing defaults) in `.xcconfig` files.
- Layered: `Common.xcconfig` → `App.xcconfig` → `App.Debug.xcconfig`.
- The `.xcodeproj` references xcconfigs at Project + Target build-config; no inline settings.

## Shared schemes — checked in
- Every CI-built scheme MUST be Shared (`xcshareddata/xcschemes/*.xcscheme` in git).
- A scheme not in git can't be built by CI.
- Personal schemes go in `xcuserdata/` (gitignored).

## `xcodebuild` is the build, not Xcode GUI
- CI runs `xcodebuild build` / `xcodebuild test`.
- Invocation: `-scheme`, `-destination`, `-configuration`, `-derivedDataPath`, `-resultBundlePath`.
- Do NOT depend on Xcode's implicit dependency graph; declare deps explicitly.

## Code signing
- Dev: Xcode automatic signing; Team ID in xcconfig (`DEVELOPMENT_TEAM = ABCD1234EF`).
- Release: Manual signing; profile NAME in xcconfig (`PROVISIONING_PROFILE_SPECIFIER = AppStore-Distribution`).
- Profiles + certificates NEVER in git; fetch from secret storage (App Store Connect API, fastlane match).

## Dependencies — SPM preferred
- SPM in `Package.swift` (packages) or project's `XCPackageReference` (apps).
- Lock `Package.resolved` (committed) for repeatable builds.
- Vendored `.xcframework` in versioned `Frameworks/` subdirectory.


> When a rule is unclear, read `agents/docs/ios/ios-xcodebuild-details.md`.
