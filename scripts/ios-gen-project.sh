#!/usr/bin/env bash
# Ensure the gitignored Local.xcconfig exists (xcodegen validation requires it),
# then regenerate the Xcode project from the spec. Used by both ios-setup.sh (dev)
# and the fastlane release lane.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LX="$REPO/ios/App/Local.xcconfig"
EX="$REPO/ios/App/Local.xcconfig.example"
if [ ! -f "$LX" ]; then
  [ -f "$EX" ] || { echo "ERROR: $EX missing — restore the tracked template."; exit 1; }
  cp "$EX" "$LX"
fi
command -v xcodegen &>/dev/null || { echo "ERROR: xcodegen not installed (brew install xcodegen)."; exit 1; }
( cd "$REPO/ios" && xcodegen generate )
