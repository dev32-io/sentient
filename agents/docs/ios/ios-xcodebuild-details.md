# Xcode Build Conventions -- Details & Examples

This file expands `platforms/ios/rules/ios-xcodebuild.md`. The
templates below show the xcconfig layout, the shared-scheme
checklist, and the `xcodebuild` invocations used in CI.

## xcconfig layered template

The project uses three layers. Each layer #includes the one
below it.

`Config/Common.xcconfig` -- settings every target shares:

```
// Common.xcconfig
// Settings shared by every target + configuration.

SWIFT_VERSION = 6.0
IPHONEOS_DEPLOYMENT_TARGET = 17.0
ENABLE_MODULE_VERIFIER = YES
SWIFT_TREAT_WARNINGS_AS_ERRORS = YES
GCC_TREAT_WARNINGS_AS_ERRORS = YES
SWIFT_STRICT_CONCURRENCY = complete
CLANG_ANALYZER_NONNULL = YES

// Enable warnings the team has agreed are errors.
CLANG_WARN_UNGUARDED_AVAILABILITY = YES_AGGRESSIVE
CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER = YES
```

`Config/App.xcconfig` -- target-level settings for the App
target:

```
// App.xcconfig
#include "Common.xcconfig"

PRODUCT_NAME = App
PRODUCT_BUNDLE_IDENTIFIER = com.example.app
DEVELOPMENT_TEAM = ABCD1234EF
INFOPLIST_FILE = App/Info.plist

ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon
TARGETED_DEVICE_FAMILY = 1,2  // iPhone + iPad
```

`Config/App.Debug.xcconfig` -- per-configuration overrides:

```
// App.Debug.xcconfig
#include "App.xcconfig"

SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG
SWIFT_OPTIMIZATION_LEVEL = -Onone
GCC_PREPROCESSOR_DEFINITIONS = DEBUG=1
CODE_SIGN_STYLE = Automatic
```

`Config/App.Release.xcconfig`:

```
// App.Release.xcconfig
#include "App.xcconfig"

SWIFT_OPTIMIZATION_LEVEL = -O
SWIFT_COMPILATION_MODE = wholemodule
GCC_PREPROCESSOR_DEFINITIONS =
CODE_SIGN_STYLE = Manual
PROVISIONING_PROFILE_SPECIFIER = AppStore-Distribution
CODE_SIGN_IDENTITY = iPhone Distribution
```

In the project file: Project -> Info -> Configurations ->
Debug = `App.Debug`, Release = `App.Release`. Target build
settings are LEFT BLANK -- they all come from the xcconfig.

## Shared scheme checklist

When you add a scheme, check ALL of the following before
committing:

- [ ] Scheme is marked Shared in Xcode (Manage Schemes... ->
  Shared column checked).
- [ ] `.xcscheme` file appears at
  `*.xcodeproj/xcshareddata/xcschemes/*.xcscheme`.
- [ ] Scheme builds with `xcodebuild -scheme <name> -showBuildSettings`
  with no errors from the command line.
- [ ] Scheme's Run / Test / Profile / Analyze / Archive
  configurations all point at the right build configuration
  (Debug for Run/Test, Release for Archive).
- [ ] Test action references the test target(s) (if any).
- [ ] No "user-only" pre-actions or post-actions that depend on
  local paths.
- [ ] `xcuserdata/` is gitignored at the project file level.

## `xcodebuild` invocations

Build, debug configuration, simulator:

```sh
xcodebuild build \
  -scheme App \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=iPhone 15" \
  -derivedDataPath build/ \
  -quiet
```

Test, with result bundle for CI parsing:

```sh
xcodebuild test \
  -scheme App \
  -destination "platform=iOS Simulator,name=iPhone 15" \
  -resultBundlePath build/TestResults.xcresult \
  -derivedDataPath build/ \
  -quiet
```

Archive for release (CI):

```sh
xcodebuild archive \
  -scheme App \
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

## CI quality gate -- the wrapper script

The platform-level hook
`platforms/ios/hooks/quality-gate-ios.sh` calls into this
matrix:

| Scope         | Command                              |
| ------------- | ------------------------------------ |
| `lint`        | `swiftlint` (or skip if not present) |
| `typecheck`   | `xcodebuild build`                   |
| `test`        | `xcodebuild test`                    |
| `all`         | lint -> build -> test, in order      |

Driving these from a single shell script keeps the local and CI
contract identical: `sh platforms/ios/hooks/quality-gate-ios.sh all`
produces the same result on a developer laptop and on the CI
runner.

## What NOT to commit

- `xcuserdata/` (user-specific Xcode state).
- `*.xcuserstate`, `*.xcuserdatad/`.
- `*.p12`, `*.mobileprovision`, `*.cer` (signing material).
- `build/`, `DerivedData/`.
- The contents of an `App Store Connect API` key JSON.

`.gitignore` at the repo root must cover all of these. A
careless commit of any signing key is a credential leak.
