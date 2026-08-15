# iOS Xcode build details

This file expands `.claude/rules/ios.md`. Read it when build guidance is unclear.

## Source of truth

`ios/project.yml` is the XcodeGen source of truth. The deployment target is iOS 18. Generate the project with `xcodegen generate`; do not hand-edit or commit the generated `.xcodeproj`, schemes, or user data.

The app and `SentientAppTests` use the variant-neutral framework dependency:

```text
../shared/mobile-data/build/XCFrameworks/MobileData.xcframework
```

Rebuild the MobileData XCFramework after shared mobile code changes, then regenerate before building. Do not invent debug/release-specific framework paths in project documentation.

## Common checks

From the repository root:

```sh
./scripts/ios-setup.sh
xcodebuild build -project ios/SentientApp.xcodeproj -scheme SentientApp \
  -destination 'platform=iOS Simulator,name=iPhone 16'
xcodebuild test -project ios/SentientApp.xcodeproj -scheme SentientApp \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

Use an installed simulator destination when iPhone 16 is unavailable. Debug-local gateway/signing values belong in the ignored `ios/App/Local.xcconfig`; keep its tracked example current. Do not claim a Swift strict-concurrency setting unless it is verified in `project.yml` or generated build settings.
