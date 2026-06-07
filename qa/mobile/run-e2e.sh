#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# qa/mobile/run-e2e.sh — Maestro E2E harness for Android + iOS
#
# Usage:
#   ./qa/mobile/run-e2e.sh [android|ios|all]   (default: all)
#
# Prerequisites:
#   - Local gateway stack running (docker compose up in deploy/macos/)
#   - Android emulator-5554 booted (appId io.dev32.sentient.debug)
#   - iOS simulator DB6D8CAF-B12E-44CA-87EB-6A0DD51FFA75 booted
#   - Both debug apps installed; apps log in via persisted token (chat shows directly)
#   - ~/.maestro/bin/maestro on PATH or reachable at the MAESTRO var below
#   - adb on PATH (Android flows)
#
# Flow directories:
#   qa/mobile/flows/android/  — Android-specific flows (resource-ids via testTags)
#   qa/mobile/flows/ios/      — iOS-specific flows (accessibilityIdentifiers)
#
# Exit code: 0 if all selected flows pass, 1 otherwise.
# ---------------------------------------------------------------------------
set -euo pipefail

MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLOWS_DIR="$REPO_ROOT/qa/mobile/flows"

ANDROID_DEVICE="emulator-5554"
IOS_DEVICE="DB6D8CAF-B12E-44CA-87EB-6A0DD51FFA75"
ANDROID_APP="io.dev32.sentient.debug"
IOS_APP="io.dev32.sentient.debug"

TARGET="${1:-all}"   # android | ios | all

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }

# ── Pre-flight checks ─────────────────────────────────────────────────────────

check_gateway() {
  info "Checking local gateway stack…"
  local healthy
  healthy=$(docker ps --filter "name=sentient-gateway" --filter "health=healthy" --format "{{.Names}}" 2>/dev/null || true)
  if [[ -z "$healthy" ]]; then
    echo -e "${RED}[ERROR]${NC} sentient-gateway is not running or not healthy."
    echo "       Start with: cd deploy/macos && docker compose up -d"
    exit 1
  fi
  pass "Gateway healthy"
}

check_android() {
  info "Checking Android emulator-5554…"
  if ! adb devices 2>/dev/null | grep -q "^emulator-5554.*device$"; then
    echo -e "${RED}[ERROR]${NC} emulator-5554 is not booted or not connected via adb."
    exit 1
  fi
  pass "Android emulator-5554 ready"
}

check_ios() {
  info "Checking iOS simulator ${IOS_DEVICE}..."
  if ! xcrun simctl list devices booted 2>/dev/null | grep -q "$IOS_DEVICE"; then
    echo -e "${RED}[ERROR]${NC} iOS simulator $IOS_DEVICE is not booted."
    exit 1
  fi
  pass "iOS simulator ready"
}

# ── (Re)install helpers ───────────────────────────────────────────────────────
# Apps are expected to already be installed with a persisted auth token.
# These reinstall if needed (e.g. after a code change). Uncomment to force.

reinstall_android() {
  info "Reinstalling Android debug APK…"
  (cd "$REPO_ROOT" && ./gradlew :android:installDebug 2>&1 | tail -3)
  pass "Android APK installed"
}

reinstall_ios() {
  info "Building + reinstalling iOS app…"
  (cd "$REPO_ROOT/ios" && \
    xcodegen generate 2>&1 | tail -2 && \
    xcodebuild -project SentientApp.xcodeproj \
      -scheme SentientApp \
      -destination "id=$IOS_DEVICE" \
      -configuration Debug build 2>&1 | grep -E "BUILD|error:" | tail -5 && \
    xcrun simctl install "$IOS_DEVICE" \
      "$(ls -d "$HOME/Library/Developer/Xcode/DerivedData/SentientApp-"*/Build/Products/Debug-iphonesimulator/SentientApp.app 2>/dev/null | head -1)"
  )
  pass "iOS app installed"
}

# ── Run Maestro flows ─────────────────────────────────────────────────────────

# run_android_reconnect — handles the two-part 04-reconnect flow that requires
# adb WiFi toggling between the assertion and recovery steps. The flow cannot
# run shell commands internally (Maestro 2.6.0 has no shell API), so the harness
# orchestrates: disable WiFi → run 04-reconnect (banner assert) → enable WiFi →
# run 04b-reconnect-recover (clear assert). Runs with --no-stop so the app stays
# open between the two flows.
run_android_reconnect() {
  local device="$1"
  local flow_dir="$FLOWS_DIR/android"
  local overall=0

  echo ""
  info "  → 04-reconnect (WiFi-drop + banner)"
  # Disable WiFi on the emulator BEFORE starting the assertion flow.
  adb -s "$device" shell svc wifi disable
  if "$MAESTRO" --device "$device" test "$flow_dir/04-reconnect.yaml"; then
    pass "  04-reconnect"
    # Re-enable WiFi so the app can recover.
    adb -s "$device" shell svc wifi enable
    echo ""
    info "  → 04b-reconnect-recover (banner-clear + composer)"
    if "$MAESTRO" --device "$device" test "$flow_dir/04b-reconnect-recover.yaml"; then
      pass "  04b-reconnect-recover"
    else
      fail "  04b-reconnect-recover"
      overall=1
    fi
  else
    fail "  04-reconnect"
    adb -s "$device" shell svc wifi enable  # always restore
    overall=1
  fi
  return $overall
}

run_platform() {
  local platform="$1"  # android | ios
  local device="$2"
  local flow_dir="$FLOWS_DIR/$platform"
  local overall=0

  info "Running $platform flows from $flow_dir against device $device"
  for flow in "$flow_dir"/*.yaml; do
    local name
    name=$(basename "$flow")
    # Skip 04b — it's driven by run_android_reconnect, not the loop.
    [[ "$name" == "04b-"* ]] && continue
    echo ""
    info "  → $name"
    if [[ "$platform" == "android" && "$name" == "01-send-stream.yaml" ]]; then
      # Run the flow; on success grep logcat for ≥1 MessageDelta (proves streaming).
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
        # Allow a moment for the SDK to finish flushing logs.
        sleep 1
        # Grep the full logcat buffer (no PID filter — the app may have been
        # relaunched by launchApp, creating a new PID different from the one
        # that processed the send). We look for MessageDelta in the entire
        # in-memory buffer which covers all recent app runs.
        local delta_count
        delta_count=$(adb -s "$device" logcat -d 2>/dev/null \
          | grep -cE "MessageDelta|message\.delta" || true)
        if [[ "$delta_count" -ge 1 ]]; then
          pass "  logcat: $delta_count MessageDelta events (streaming confirmed)"
        else
          fail "  logcat: no MessageDelta found — streaming may not be working"
          overall=1
        fi
      else
        fail "  $name"
        overall=1
      fi
    elif [[ "$platform" == "android" && "$name" == "04-reconnect.yaml" ]]; then
      # Reconnect flow requires a physical device (emulators use Ethernet, not WiFi).
      # On emulators skip and flag; on physical devices call run_android_reconnect.
      if echo "$device" | grep -q "^emulator-"; then
        info "  SKIPPED (emulator limitation: WiFi toggle has no effect on virtual Ethernet)"
        info "  → Flag: 04-reconnect requires physical Android device or Docker gateway stop"
      else
        run_android_reconnect "$device" || overall=1
      fi
    else
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
      else
        fail "  $name"
        overall=1
      fi
    fi
  done
  return $overall
}

# ── Main ──────────────────────────────────────────────────────────────────────

echo ""
echo "===== Sentient Mobile E2E Harness ====="
echo "Target: $TARGET"
echo ""

check_gateway

EXIT=0

case "$TARGET" in
  android)
    check_android
    run_platform android "$ANDROID_DEVICE" || EXIT=1
    ;;
  ios)
    check_ios
    run_platform ios "$IOS_DEVICE" || EXIT=1
    ;;
  all)
    check_android
    check_ios
    run_platform android "$ANDROID_DEVICE" || EXIT=1
    run_platform ios     "$IOS_DEVICE"     || EXIT=1
    ;;
  *)
    echo "Usage: $0 [android|ios|all]"
    exit 1
    ;;
esac

echo ""
if [[ "$EXIT" -eq 0 ]]; then
  pass "All flows GREEN"
else
  fail "One or more flows FAILED — see above"
fi
exit "$EXIT"
