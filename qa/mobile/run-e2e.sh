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
# Flows with special harness handling (pre-conditions, broadcasts, log greps):
#   04-reconnect        — WiFi toggle (emulator: skipped; physical: adb wifi)
#   09-logout           — no special pre-condition; asserts login-backend-setup
#   10-outbox           — launchApp clearState, immediate send
#   18-auth-expired     — broadcast expired-token fault BEFORE running flow
#   20-malformed-frame  — broadcast malformed-frame fault BEFORE running flow
#   08-voice-loop       — push fixture + broadcast BEFORE running flow
#
# Exit code: 0 if all selected flows pass, 1 otherwise.
# ---------------------------------------------------------------------------
set -euo pipefail

MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLOWS_DIR="$REPO_ROOT/qa/mobile/flows"
FIXTURES_DIR="$REPO_ROOT/qa/mobile/fixtures"

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
flag() { echo -e "${YELLOW}[FLAG]${NC} $*"; }

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

# ── Fault-injection helpers (Android only) ────────────────────────────────────

arm_fault() {
  local device="$1"; local kind="$2"
  info "  Arming fault kind=$kind on $device"
  # -p restricts the broadcast to the app package so exported=true is still scoped.
  # exported=true is required for adb to target a non-exported receiver (Android 8+).
  adb -s "$device" shell am broadcast \
    -a io.sentient.debug.FAULT \
    -p "$ANDROID_APP" \
    --es kind "$kind" \
    2>/dev/null || true
  sleep 1  # Give the BroadcastReceiver time to process
}

push_and_arm_fixture() {
  local device="$1"
  local fixture_local="$FIXTURES_DIR/silence-500ms.pcm"
  local fixture_name="sentient-fixture.pcm"
  local cache_path="/data/user/0/$ANDROID_APP/cache/$fixture_name"
  info "  Pushing fixture to $device app cache: $cache_path"
  # Pipe the fixture bytes into the app's cache dir via run-as (debug builds only).
  # This avoids needing READ_EXTERNAL_STORAGE: the file lands in app-private storage.
  cat "$fixture_local" | adb -s "$device" shell \
    "run-as $ANDROID_APP sh -c 'cat > $cache_path'" 2>/dev/null || \
    info "  WARNING: fixture push via run-as failed — fixture injection will not work"
  # Arm the fixture broadcast on the RUNNING app (no relaunch).
  adb -s "$device" shell am broadcast \
    -a io.sentient.debug.FAULT \
    -p "$ANDROID_APP" \
    --es kind fixture \
    --es name "$fixture_name" \
    2>/dev/null || true
  sleep 1
}

grep_logcat_for() {
  local device="$1"; local pattern="$2"; local label="$3"
  local count
  count=$(adb -s "$device" logcat -d 2>/dev/null | grep -cE "$pattern" || true)
  if [[ "$count" -ge 1 ]]; then
    pass "  logcat: $count '$label' events found"
    return 0
  else
    fail "  logcat: no '$label' found (pattern: $pattern)"
    return 1
  fi
}

# Grant mic permission before any mic flow to avoid system dialog popping on emulator
grant_mic_permission() {
  local device="$1"
  info "  Granting RECORD_AUDIO permission for $ANDROID_APP"
  adb -s "$device" shell pm grant "$ANDROID_APP" android.permission.RECORD_AUDIO 2>/dev/null || true
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

  # Pre-grant mic permission for Android so 11-mic-control + 08-voice-loop don't
  # pop a system dialog that Maestro cannot dismiss.
  if [[ "$platform" == "android" ]]; then
    grant_mic_permission "$device"
  fi

  info "Running $platform flows from $flow_dir against device $device"
  # logout_flow is deferred to the end so it doesn't invalidate the auth token
  # for subsequent flows (10-outbox, 11-mic-control, etc.) that need a logged-in session.
  local logout_flow=""
  for flow in "$flow_dir"/*.yaml; do
    local name
    name=$(basename "$flow")
    # Skip 04b — it's driven by run_android_reconnect, not the loop.
    [[ "$name" == "04b-"* ]] && continue
    # Defer 09-logout to the end (it clears the token).
    if [[ "$name" == "09-logout.yaml" ]]; then
      logout_flow="$flow"
      continue
    fi
    echo ""
    info "  → $name"

    # ── Per-flow special handling ─────────────────────────────────────────────
    if [[ "$platform" == "android" && "$name" == "01-send-stream.yaml" ]]; then
      # Run the flow; on success grep logcat for ≥1 MessageDelta (proves streaming).
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
        sleep 1
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
      if echo "$device" | grep -q "^emulator-"; then
        info "  SKIPPED (emulator limitation: WiFi toggle has no effect on virtual Ethernet)"
        flag "  04-reconnect requires physical Android device or Docker gateway stop"
      else
        run_android_reconnect "$device" || overall=1
      fi

    elif [[ "$platform" == "android" && "$name" == "11-mic-control.yaml" ]]; then
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
        sleep 1
        # Log trail: startMic / stopMic in logcat
        grep_logcat_for "$device" "startMic|stopMic" "startMic/stopMic" || overall=1
      else
        fail "  $name"
        overall=1
      fi

    elif [[ "$platform" == "android" && "$name" == "18-auth-expired.yaml" ]]; then
      # Arm the fault BEFORE running the flow (launchApp triggers a connect cycle).
      arm_fault "$device" "expired"
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
        sleep 1
        grep_logcat_for "$device" "fault\.expired-token|hasSession\.clear" "fault.expired-token or hasSession.clear" || overall=1
      else
        fail "  $name"
        overall=1
      fi

    elif [[ "$platform" == "android" && "$name" == "20-malformed-frame.yaml" ]]; then
      # Arm fault on the RUNNING app then run the flow WITHOUT relaunching.
      # The flow starts from the existing foreground session.
      adb -s "$device" logcat -c 2>/dev/null || true
      arm_fault "$device" "malformed"
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
        sleep 1
        grep_logcat_for "$device" "fault\.malformed-frame|decode-failed" "fault.malformed-frame or decode-failed" || overall=1
      else
        fail "  $name"
        overall=1
      fi

    elif [[ "$platform" == "android" && "$name" == "18-auth-expired.yaml" ]]; then
      # Orchestration: ensure app running → arm fault → stop Docker gateway →
      # run flow (SDK reconnects → auth.ok intercepted → login screen).
      # Restore gateway after the flow.
      adb -s "$device" logcat -c 2>/dev/null || true
      arm_fault "$device" "expired"
      info "  Stopping gateway to force SDK reconnect (auth-expired test)"
      docker stop sentient-gateway 2>/dev/null || true
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
        sleep 1
        grep_logcat_for "$device" "fault\.expired-token|hasSession\.clear" "fault.expired-token or hasSession.clear" || overall=1
      else
        fail "  $name"
        overall=1
      fi
      # Always restart the gateway so subsequent flows work.
      info "  Restarting gateway after auth-expired test"
      docker start sentient-gateway 2>/dev/null || true
      sleep 5  # Give gateway time to become healthy
      # Re-login: the auth-expired flow routes to login; the next flows need a session.
      info "  Re-logging in after auth-expired test (PIN 1234)"
      "$MAESTRO" --device "$device" test "$REPO_ROOT/qa/android/charters/sanity-logout.yaml" 2>/dev/null | grep -E "COMPLETED|FAILED" | head -5 || true

    elif [[ "$platform" == "android" && "$name" == "08-voice-loop.yaml" ]]; then
      # Push fixture + arm on the RUNNING app then run the flow.
      adb -s "$device" logcat -c 2>/dev/null || true
      push_and_arm_fixture "$device"
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
        sleep 1
        # Fixture plumbing: assert fixture was injected + uplink started
        grep_logcat_for "$device" "fixture-utterance" "fixture-utterance (FaultAwareCaptureAdapter)" || overall=1
        grep_logcat_for "$device" "startMic" "startMic (uplink started)" || overall=1
        flag "  08-voice-loop: FULL STT→LLM→TTS requires a real speech fixture (see qa/mobile/fixtures/README.md)"
      else
        fail "  $name"
        overall=1
      fi

    elif [[ "$platform" == "ios" && "$name" == "07-rename-delete.yaml" ]]; then
      # iOS swipe-actions may be flaky in Maestro; flag if it fails.
      if "$MAESTRO" --device "$device" test "$flow"; then
        pass "  $name"
      else
        fail "  $name"
        flag "  07-rename-delete (iOS): swipe-action Maestro reliability — may need UITest instrumentation"
        overall=1
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

  # ── Deferred 09-logout (runs last to avoid breaking authenticated flows) ─────
  if [[ -n "$logout_flow" ]]; then
    local lname
    lname=$(basename "$logout_flow")
    echo ""
    info "  → $lname (deferred — runs last)"
    if [[ "$platform" == "android" ]]; then
      if "$MAESTRO" --device "$device" test "$logout_flow"; then
        pass "  $lname"
      else
        fail "  $lname"
        overall=1
      fi
    elif [[ "$platform" == "ios" ]]; then
      flag "  09-logout (iOS): FLAGGED — no settings-open affordance in iOS ChatTitleBar."
      flag "                   settings-open must be added to ChatTitleBar for iOS logout E2E."
      if "$MAESTRO" --device "$device" test "$logout_flow"; then
        pass "  $lname (partial — reached composer, not login)"
      else
        fail "  $lname"
        overall=1
      fi
    fi
  fi

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
