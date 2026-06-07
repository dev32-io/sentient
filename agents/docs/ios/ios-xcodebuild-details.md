# Xcode Build Conventions -- Details & Examples

This file expands `.claude/rules/ios/ios-xcodebuild.md`. The project is generated from `ios/project.yml` (XcodeGen); the templates below show the project.yml settings, the generated scheme, and the `xcodebuild` invocations used in CI.

## project.yml — the source of truth

`SentientApp.xcodeproj/` is gitignored and regenerated with `xcodegen generate`. Settings live in `project.yml`, NOT a checked-in `Config/*.xcconfig` tree:

```yaml
options:
  bundleIdPrefix: io.dev32
  deploymentTarget: { iOS: "17.0" }
targets:
  SentientApp:
    type: application
    sources: [App]
    configFiles:
      Debug: App/Local.xcconfig            # gitignored; dev gateway URL + local signing
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: io.dev32.sentient
        GENERATE_INFOPLIST_FILE: NO
      configs:
        Debug: { PRODUCT_BUNDLE_IDENTIFIER: io.dev32.sentient.debug }   # .debug → side-by-side install
    dependencies:
      - framework: ../shared/mobile-data/build/XCFrameworks/debug/MobileData.xcframework
        embed: false
      - package: MarkdownUI
        product: MarkdownUI
```

The only xcconfig is `App/Local.xcconfig` (gitignored), with `App/Local.xcconfig.example` tracked as the template. Swift strict-concurrency / Swift version are set via project.yml settings (or the per-target defaults), not a layered Common/App/App.Debug stack.

## Schemes — declared in project.yml, generated

```yaml
schemes:
  SentientApp:
    build:
      targets: { SentientApp: all, SentientAppTests: [test] }
    test:
      targets: [SentientAppTests]
```

XcodeGen emits the shared `.xcscheme` on generate — do NOT hand-author or commit one. `xcuserdata/` stays gitignored. After editing `project.yml`, run `xcodegen generate` before building so the project matches.

## `xcodebuild` invocations

Build, debug configuration, simulator:

```sh
xcodebuild build \
  -scheme SentientApp \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=iPhone 15" \
  -derivedDataPath build/ \
  -quiet
```

Test, with result bundle for CI parsing:

```sh
xcodebuild test \
  -scheme SentientApp \
  -destination "platform=iOS Simulator,name=iPhone 15" \
  -resultBundlePath build/TestResults.xcresult \
  -derivedDataPath build/ \
  -quiet
```

Archive for release (CI):

```sh
xcodebuild archive \
  -scheme SentientApp \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath build/App.xcarchive \
  -derivedDataPath build/ \
  -allowProvisioningUpdates
```

The `-allowProvisioningUpdates` flag lets CI's signing flow
fetch profiles from App Store Connect via the API key. Pair it
with `xcrun altool --apiKey` or `fastlane match`.

## SPM dependencies

In `Package.swift` (for a Swift Package target inside the
project) or in the project's Package Dependencies tab:

```swift
let package = Package(
    name: "App",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "App", targets: ["App"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-collections.git",
                 from: "1.1.0"),
    ],
    targets: [
        .target(name: "App", dependencies: [
            .product(name: "Collections", package: "swift-collections"),
        ]),
        .testTarget(name: "AppTests", dependencies: ["App"]),
    ]
)
```

`Package.resolved` is checked in -- it pins exact versions for
repeatable CI. `git diff Package.resolved` after a dependency
bump is the change you review when upgrading.

## CI quality gate

The gate is: `xcodegen generate` → `xcodebuild build` → `xcodebuild test` (+ `swiftlint` if present), against a simulator destination. There is no `platforms/ios/hooks/quality-gate-ios.sh` — that path does not exist. Native-mobile E2E is driven separately by `qa/mobile/run-e2e.sh` (Maestro + `xcrun simctl`); see `ios-testing`.

| Scope       | Command                                  |
| ----------- | ---------------------------------------- |
| `lint`      | `swiftlint` (skip if not installed)      |
| `typecheck` | `xcodegen generate` → `xcodebuild build` |
| `test`      | `xcodebuild test`                        |
| `e2e`       | `qa/mobile/run-e2e.sh` (Maestro/simctl)  |

## What NOT to commit

- `xcuserdata/` (user-specific Xcode state).
- `*.xcuserstate`, `*.xcuserdatad/`.
- `*.p12`, `*.mobileprovision`, `*.cer` (signing material).
- `build/`, `DerivedData/`.
- The contents of an `App Store Connect API` key JSON.

`.gitignore` at the repo root must cover all of these. A
careless commit of any signing key is a credential leak.
