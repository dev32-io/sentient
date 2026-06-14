#!/usr/bin/env bash
# Local iOS dev setup: build the DEBUG KMP XCFramework, place it at the stable
# variant-neutral path the spec references, then generate the Xcode project.
# Run this before opening ios/SentientApp.xcodeproj.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
( cd "$REPO" && ./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework )
DST="$REPO/shared/mobile-data/build/XCFrameworks"
# Guard before the destructive rm: if gradle exited 0 but the output is absent
# (e.g. the task name drifted), don't wipe a previously-good stable copy.
[ -d "$DST/debug/MobileData.xcframework" ] || { echo "ERROR: gradle succeeded but $DST/debug/MobileData.xcframework is missing."; exit 1; }
rm -rf "$DST/MobileData.xcframework"
cp -R "$DST/debug/MobileData.xcframework" "$DST/MobileData.xcframework"
"$REPO/scripts/ios-gen-project.sh"
echo "✓ iOS project ready (debug XCFramework at stable path). Open ios/SentientApp.xcodeproj."
