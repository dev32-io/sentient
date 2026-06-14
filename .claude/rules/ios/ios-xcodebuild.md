---
description: Xcode build -- XcodeGen spec is source of truth, settings + local xcconfig, xcodebuild for CI.
paths:
  - "ios/project.yml"
  - "ios/**/*.xcconfig"
  - "ios/**/*.xcconfig.example"
---

# Xcode Build Conventions

The project is GENERATED, not hand-edited: an XcodeGen spec is the single source of truth; the `.xcodeproj` is gitignored and regenerated. Never edit the project blob by hand — the change is lost on the next generate.

## Build settings — spec + a single local xcconfig

- Target/build settings live in the XcodeGen spec, NOT a checked-in layered xcconfig tree.
- The only xcconfig is a gitignored local override (dev gateway URL + local signing), with a tracked example template.
- Info.plist values + capabilities are declared in the spec.

## Schemes — declared in the spec, generated

- Schemes are declared in the spec and emitted on generate; do NOT hand-author or commit a scheme file. Personal state stays gitignored.

## `xcodebuild` is the build, not the GUI

- CI/local gates run `xcodebuild build` / `xcodebuild test` against a simulator destination.
- Regenerate the project before building so it matches the spec.
- Local dev: regenerate + build via `scripts/ios-setup.sh` (debug XCFramework → stable path → xcodegen). Release ipa: `scripts/build-ios.sh`. See `docs/mobile-release.md`.

## Dependencies — vendored XCFramework + SPM

- The shared KMP code is a vendored, SKIE-bridged XCFramework referenced by the spec; the app imports it and the SDK types re-export through it.
- SPM packages are declared in the spec; commit the resolved lockfile.
- Rebuild the XCFramework when shared code changes; a stale one link-fails or runs old code.

## Code signing

- Dev: automatic signing; team id in the local xcconfig, never committed. Profiles + certificates never in git.

> When a rule is unclear, read `agents/docs/ios/ios-xcodebuild-details.md`.
