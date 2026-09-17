#!/usr/bin/env bash
# Synthetic DEBUG catalog only. No backend, credentials, audio, or existing simulator state.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source scripts/env.sh

OUT="${1:?usage: profile-ios-hybrids.sh OUTPUT_DIRECTORY [family ...]}"
shift
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
if [[ $# -eq 0 ]]; then
  set -- foundation controls forms feedback composites history chat voice notifications calendar
fi
for family in "$@"; do
  case "$family" in
    foundation|controls|forms|feedback|composites|history|chat|voice|notifications|calendar) ;;
    *) echo "Unknown catalog family: $family" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d /tmp/sentient-hybrid-profile.XXXXXX)"
UDID=""
SAMPLER=""
cleanup() {
  if [[ -n "$SAMPLER" ]]; then kill "$SAMPLER" 2>/dev/null || true; fi
  if [[ -n "$UDID" ]]; then
    xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
    xcrun simctl delete "$UDID" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
# A visual-diff capture request overrides app launch routing. Never delete someone else's request.
if [[ -e /tmp/sentient-visual-diff-request ]]; then
  echo "Finish the active visual-diff capture before profiling." >&2
  exit 1
fi
UDID="$(xcrun simctl create sentient-hybrid-profile \
  com.apple.CoreSimulator.SimDeviceType.iPhone-16 \
  "${IOS_PROFILE_RUNTIME:-com.apple.CoreSimulator.SimRuntime.iOS-26-5}")"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp \
  -configuration Debug -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$WORK/derived" SWIFT_OPTIMIZATION_LEVEL=-O \
  DEBUG_INFORMATION_FORMAT=dwarf-with-dsym GATEWAY_WS_URL= build >"$OUT/build.log" 2>&1
APP="$WORK/derived/Build/Products/Debug-iphonesimulator/SentientApp.app"
codesign --verify --deep --strict "$APP"
xcrun simctl install "$UDID" "$APP"

cat >"$WORK/scroll.yaml" <<'YAML'
appId: io.dev32.sentient.debug
---
- assertVisible:
    id: qa-foundation-catalog
- repeat:
    times: 4
    commands:
      - swipe:
          start: 50%, 35%
          end: 50%, 60%
          duration: 250
- repeat:
    times: 4
    commands:
      - swipe:
          start: 50%, 60%
          end: 50%, 35%
          duration: 250
YAML

{ git rev-parse HEAD; xcodebuild -version; xcrun simctl list devices | grep "$UDID"; } >"$OUT/environment.txt"
# HEAD alone cannot identify an uncommitted optimization trial. Record source, not app data.
git status --short -- ios shared/mobile-sdk shared/mobile-data qa/design-refresh >"$OUT/source-status.txt"
git diff HEAD -- ios/App ios/project.yml >"$OUT/source.patch"
find ios/App shared/mobile-sdk/src shared/mobile-data/src -type f \
  \( -name '*.swift' -o -name '*.kt' -o -name '*.riv' \) -print0 \
  | sort -z | xargs -0 shasum -a 256 >"$OUT/source-sha256.txt"
shasum -a 256 "$APP/SentientApp" >"$OUT/app-sha256.txt"
for family in "$@"; do
  xcrun simctl terminate "$UDID" io.dev32.sentient.debug >/dev/null 2>&1 || true
  PID="$(xcrun simctl launch "$UDID" io.dev32.sentient.debug \
    --qa-foundation-catalog --qa-foundation-family "$family" | awk '{print $NF}')"
  maestro --device "$UDID" test "$WORK/scroll.yaml" >"$OUT/$family-warmup.log" 2>&1
  sample "$PID" 25 1 -file "$OUT/$family.sample.txt" >"$OUT/$family-sample.log" 2>&1 &
  SAMPLER=$!
  maestro --device "$UDID" test "$WORK/scroll.yaml" >"$OUT/$family-scroll.log" 2>&1
  wait "$SAMPLER"
  SAMPLER=""
  xcrun simctl io "$UDID" screenshot "$OUT/$family.png" >/dev/null 2>&1
done
