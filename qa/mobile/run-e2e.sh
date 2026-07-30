#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# qa/mobile/run-e2e.sh ? Maestro E2E harness for Android + iOS (batch runner).
#
# The library is optimised for CHEAP TARGETED subset runs: one warm
# `maestro test --include-tags=... <dir>` batch instead of one cold JVM per flow
# (the old per-flow loop paid a 42-65s fixed JVM/attach cost on EVERY flow). The
# workspace config.yaml pins a deterministic execution order (restore pairs
# adjacent, logout last) and continueOnFailure, so a single invocation runs the
# whole selection in order and still runs every restore even if a primary fails.
#
# Usage:
#   ./qa/mobile/run-e2e.sh [android|ios|all]              # default: all
#   ./qa/mobile/run-e2e.sh android --tags settings-soul,settings-voice
#   ./qa/mobile/run-e2e.sh android --no-slow              # drop >2min flows
#   ./qa/mobile/run-e2e.sh android --fault-only           # only the armed flows
#   ./qa/mobile/run-e2e.sh android --no-fault             # skip the armed phase
#   ./qa/mobile/run-e2e.sh android --fresh-gateway        # restart gateway first
#
# SESSION CAP: every launchApp opens a WS session; the gateway caps a user at 40
# concurrent sessions and archives idle ones only after ~30 min. A long day of
# batches can exhaust the cap -> new WS connects get `auth.reject code=session-limit`
# -> chat/WS flows fail while REST-only settings flows still pass. Pass
# --fresh-gateway to restart the LOCAL gateway (clears the cap) before a big run.
#
# Tag taxonomy (see any flow header + config.yaml):
#   surface : chat session reconnect outbox voice-loop auth settings-root
#             settings-soul settings-voice settings-user settings-admin
#             settings-diagnostics update logout
#   behavior: fault-armed physical-only slow destructive-profile restore helper
#
# Behaviour:
#   - Default batch (no --tags) = every flow EXCEPT fault-armed / physical-only /
#     helper, in one `maestro test` invocation; then the fault-armed flows run
#     individually with their pre-arming (broadcast / network-kill / gateway-stop).
#   - --tags X,Y = one include-tags batch (still excludes fault-armed/physical-only
#     /helper); no fault phase ? targeted runs stay fast.
#
# Prerequisites:
#   - Local gateway healthy (native: `cd gateway && bun --hot src/main.ts`; see deploy/README.md).
#   - Android emulator-5554 booted; iOS simulator booted; debug apps installed.
#   - ~/.maestro/bin/maestro on PATH (or MAESTRO=...); adb + xcrun on PATH.
#
# Ordering: Maestro's default folder order is non-deterministic and flowsOrder in
# config.yaml is incompatible with --include-tags, so the runner resolves the
# selected tags into an explicit, canonically-ordered file list (restore pairs
# adjacent, logout last) and runs `maestro test f1 f2 ... fN` (explicit arg order
# IS honored). Same strategy on BOTH platforms; verified on Android + iOS.
#
# iOS specifics: IOS_DEVICE auto-detects the booted sim (override via env). Mic
# permission is granted with `xcrun simctl privacy`. iOS has no adb-broadcast fault
# channel, so its fault phase is gateway-stop orchestration (58b/60 via
# gw_stop_or_flag; 04c continuity via gw_restart_or_flag between parts, same
# wrappers the Android 18-auth-expired case uses) -- native process, not a container
# (see the "Gateway lifecycle" block below); 08/18/20 are Android-only.
#
# Exit code: 0 if every selected flow passed, 1 otherwise.
# ---------------------------------------------------------------------------
set -euo pipefail

MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLOWS_DIR="$REPO_ROOT/qa/mobile/flows"
FIXTURES_DIR="$REPO_ROOT/qa/mobile/fixtures"

ANDROID_DEVICE="emulator-5554"
# IOS_DEVICE: env override wins; otherwise auto-detect the booted sim (the old
# hardcoded UDID goes stale). Resolved lazily in check_ios.
IOS_DEVICE="${IOS_DEVICE:-}"
ANDROID_APP="io.dev32.sentient.debug"
IOS_APP="io.dev32.sentient.debug"

# Always excluded from batch runs: harness-orchestrated + reusable subflows.
BASE_EXCLUDE="fault-armed,physical-only,helper"

# -- Args ----------------------------------------------------------------------
TARGET="all"
INCLUDE_TAGS=""
EXTRA_EXCLUDE=""
RUN_FAULT="auto"        # auto | never | only
RESTORE_ANIM="true"
FRESH_GW="auto"         # auto (restart on a full-suite run) | force | off

USAGE="Usage: $0 [android|ios|all] [--tags T1,T2] [--no-slow] [--no-fault|--fault-only] [--fresh-gateway|--no-fresh-gateway] [--no-anim-restore]"
while [[ $# -gt 0 ]]; do
  case "$1" in
    android|ios|all) TARGET="$1"; shift ;;
    --tags) INCLUDE_TAGS="${2:-}"; shift 2 ;;
    --tags=*) INCLUDE_TAGS="${1#*=}"; shift ;;
    --no-slow) EXTRA_EXCLUDE="slow"; shift ;;
    --no-fault) RUN_FAULT="never"; shift ;;
    --fault-only) RUN_FAULT="only"; shift ;;
    --fresh-gateway) FRESH_GW="force"; shift ;;
    --no-fresh-gateway) FRESH_GW="off"; shift ;;
    --no-anim-restore) RESTORE_ANIM="false"; shift ;;
    *) echo "Unknown arg: $1"; echo "$USAGE"; exit 1 ;;
  esac
done

# Decide whether to restart the gateway first (clear the per-user WS session cap):
# forced by --fresh-gateway; on a full-suite run (no --tags, not fault-only) by
# default; never for a targeted --tags run (keeps iteration fast) or --no-fresh-gateway.
should_reset_gateway() {
  case "$FRESH_GW" in
    force) return 0 ;;
    off) return 1 ;;
    auto) [[ -z "$INCLUDE_TAGS" && "$RUN_FAULT" != "only" ]] && return 0 || return 1 ;;
  esac
  return 1
}

# -- Colour helpers ------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }
flag() { echo -e "${YELLOW}[FLAG]${NC} $*"; }

# -- Gateway lifecycle -----------------------------------------------------------
# The gateway is a native host process now, not a container (native-stack
# migration, 2026-07-29) -- there is no `sentient-gateway` to `docker ps` /
# stop / start / restart any more. Dev: `cd gateway && bun --hot src/main.ts`
# (see deploy/README.md "Local dev -- macOS"); prod: launchd, never touched by
# this LOCAL-ONLY harness. These helpers manage the dev process directly: probe
# its health endpoint, and find/signal whatever is bound to :8888 rather than a
# container name. gw_start relaunches it exactly the documented dev way -- STT/TTS
# keep working regardless, since the gateway dials whichever native-addon
# processes already own their ports, independent of this restart.
GATEWAY_HEALTH_URL="https://127.0.0.1:8888/api/v1/health"
GATEWAY_USERS_URL="https://127.0.0.1:8888/api/v1/auth/users"
GATEWAY_PORT=8888
# QA_USER_ID - the login-picker avatar every authed flow taps. Server-minted, so
# it is passed to Maestro as an env var (each login helper declares the same
# default) and pre-flighted by check_qa_user before any JVM starts.
QA_USER_ID="${QA_USER_ID:-u_0417d3b0}"
GATEWAY_DEV_LOG="$REPO_ROOT/qa/mobile/logs/gateway-dev.log"

gateway_health_code() {
  curl -sk -o /dev/null -m 3 -w "%{http_code}" "$GATEWAY_HEALTH_URL" 2>/dev/null || echo "000"
}

# -- Pre-flight ----------------------------------------------------------------
check_gateway() {
  info "Checking local gateway..."
  local code
  code=$(gateway_health_code)
  if [[ "$code" != "200" ]]; then
    fail "the gateway is not running or not healthy at $GATEWAY_HEALTH_URL (got HTTP $code). Start it natively: cd gateway && bun --hot src/main.ts"
    exit 1
  fi
  pass "Gateway healthy"
}

# check_qa_user - prove the login-picker avatar the flows tap actually exists.
#
# WHY THIS EXISTS: QA_USER_ID is a SERVER-MINTED id. The native-stack cutover
# moved the gateway state root and the previous fixture user did not come with
# it; every authed flow then failed at `tapOn: login-avatar-<id>` — a SELECTOR
# failure that reads like a product regression. This turns that into one clear
# diagnostic before any JVM starts. Override with QA_USER_ID=<id> in the env.
check_qa_user() {
  info "Checking QA fixture user $QA_USER_ID..."
  local users
  users=$(curl -sk -m 5 "$GATEWAY_USERS_URL" 2>/dev/null || echo "")
  if [[ -z "$users" ]]; then
    fail "could not read $GATEWAY_USERS_URL — cannot verify the QA fixture user."
    exit 1
  fi
  if ! grep -q "\"$QA_USER_ID\"" <<<"$users"; then
    fail "QA fixture user $QA_USER_ID is NOT in the gateway's login list. The flows will fail at the avatar selector, not at their assertions."
    printf '       gateway knows: %s\n' "$(grep -o '"userId":"[^"]*"' <<<"$users" | cut -d'"' -f4 | tr '\n' ' ')"
    printf '       fix: re-run with QA_USER_ID=<an existing admin id>, or recreate the fixture user.\n'
    exit 1
  fi
  pass "QA fixture user $QA_USER_ID present"
}

# reset_gateway - restart the LOCAL gateway to clear per-user WS session state.
# Each launchApp opens a WS session; the gateway caps a user at 40 concurrent
# sessions and only archives idle ones after ~30 min, so many rapid batch launches
# (a full day of E2E) can exhaust the cap -> new WS connects get `auth.reject
# code=session-limit` -> chat/WS flows fail (REST-only flows still pass). Opt-in via
# --fresh-gateway before a large run. LOCAL dev stack only (never prod).
reset_gateway() {
  info "Restarting gateway (--fresh-gateway: clear per-user WS session cap)..."
  if gw_restart; then
    pass "Gateway restarted + healthy"
  else
    fail "gateway did not come back healthy within budget -- check $GATEWAY_DEV_LOG"
    exit 1
  fi
}

# Gateway stop/start/restart helpers used by the fault phases (offline / reconnect).
gw_wait_healthy() {
  local i
  for i in $(seq 1 40); do
    [[ "$(gateway_health_code)" == "200" ]] && return 0
    sleep 2
  done
  return 1
}
# pid of whatever is LISTENing on the gateway port; empty (not an error) when none.
gw_pid() { lsof -ti "tcp:${GATEWAY_PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
gw_stop() {
  local pid i
  pid=$(gw_pid)
  [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 20); do
    [[ -z "$(gw_pid)" ]] && return 0
    sleep 1
  done
  return 1
}
gw_start() {
  mkdir -p "$(dirname "$GATEWAY_DEV_LOG")"
  ( cd "$REPO_ROOT/gateway" && nohup bun --hot src/main.ts >>"$GATEWAY_DEV_LOG" 2>&1 & )
  gw_wait_healthy
}
gw_restart() { gw_stop; gw_start; }

# Fault-phase call sites use these wrappers, never gw_stop/gw_start bare: those
# return non-zero when they miss their budget, which under `set -e` would abort the
# whole suite mid-phase. A missed budget is a degraded fault setup, not a harness
# crash -> flag the reason, mark the batch failed, keep running the remaining flows.
gw_stop_or_flag() {
  if gw_stop; then return 0; fi
  flag "  gateway still LISTENing on :$GATEWAY_PORT after the stop budget - the next flow may not see a DOWN gateway"
  BATCH_RESULT=1
}
gw_start_or_flag() {
  if gw_start; then return 0; fi
  flag "  gateway did not come back healthy within budget - check $GATEWAY_DEV_LOG"
  BATCH_RESULT=1
}
gw_restart_or_flag() { gw_stop_or_flag; gw_start_or_flag; }

check_android() {
  info "Checking Android $ANDROID_DEVICE..."
  adb devices 2>/dev/null | grep -q "^$ANDROID_DEVICE.*device$" || { fail "$ANDROID_DEVICE not connected via adb."; exit 1; }
  pass "Android $ANDROID_DEVICE ready"
}

check_ios() {
  # Auto-detect the booted sim unless IOS_DEVICE was set in the environment.
  if [[ -z "$IOS_DEVICE" ]]; then
    IOS_DEVICE=$(xcrun simctl list devices booted 2>/dev/null | grep -oE '[0-9A-Fa-f-]{36}' | head -1)
  fi
  info "Checking iOS simulator ${IOS_DEVICE:-<none>}..."
  if [[ -z "$IOS_DEVICE" ]] || ! xcrun simctl list devices booted 2>/dev/null | grep -q "$IOS_DEVICE"; then
    fail "No booted iOS simulator (boot one, or set IOS_DEVICE=<udid>)."
    exit 1
  fi
  pass "iOS simulator $IOS_DEVICE ready"
}

setup_ios() {
  info "Setup: granting mic permission on the sim (11-mic-control / 55-voice-create)"
  xcrun simctl privacy "$IOS_DEVICE" grant microphone "$IOS_APP" 2>/dev/null || true
  pass "iOS mic permission granted"
}

# -- Android setup / teardown --------------------------------------------------
ANIM_ORIG_WIN="1"; ANIM_ORIG_TRANS="1"; ANIM_ORIG_ANIMATOR="1"

setup_android() {
  info "Setup: disabling animations + granting mic permission"
  ANIM_ORIG_WIN=$(adb -s "$ANDROID_DEVICE" shell settings get global window_animation_scale 2>/dev/null | tr -d '\r' || echo 1)
  ANIM_ORIG_TRANS=$(adb -s "$ANDROID_DEVICE" shell settings get global transition_animation_scale 2>/dev/null | tr -d '\r' || echo 1)
  ANIM_ORIG_ANIMATOR=$(adb -s "$ANDROID_DEVICE" shell settings get global animator_duration_scale 2>/dev/null | tr -d '\r' || echo 1)
  adb -s "$ANDROID_DEVICE" shell settings put global window_animation_scale 0
  adb -s "$ANDROID_DEVICE" shell settings put global transition_animation_scale 0
  adb -s "$ANDROID_DEVICE" shell settings put global animator_duration_scale 0
  # Mic permission up front so 11-mic-control / 08-voice-loop never pop a system
  # dialog (Maestro cannot dismiss it).
  adb -s "$ANDROID_DEVICE" shell pm grant "$ANDROID_APP" android.permission.RECORD_AUDIO 2>/dev/null || true
  pass "Animations off (was $ANIM_ORIG_WIN/$ANIM_ORIG_TRANS/$ANIM_ORIG_ANIMATOR), mic granted"
}

restore_android_anim() {
  [[ "$RESTORE_ANIM" == "true" ]] || return 0
  [[ -z "${ANIM_ORIG_WIN:-}" ]] && return 0
  adb -s "$ANDROID_DEVICE" shell settings put global window_animation_scale "${ANIM_ORIG_WIN:-1}" 2>/dev/null || true
  adb -s "$ANDROID_DEVICE" shell settings put global transition_animation_scale "${ANIM_ORIG_TRANS:-1}" 2>/dev/null || true
  adb -s "$ANDROID_DEVICE" shell settings put global animator_duration_scale "${ANIM_ORIG_ANIMATOR:-1}" 2>/dev/null || true
  info "Animation scales restored"
}
trap restore_android_anim EXIT

# -- Fault-injection helpers (Android only) ------------------------------------
arm_fault() {
  local kind="$1"
  info "  Arming fault kind=$kind"
  adb -s "$ANDROID_DEVICE" shell am broadcast -a io.sentient.debug.FAULT -p "$ANDROID_APP" --es kind "$kind" 2>/dev/null || true
  sleep 1
}

push_and_arm_fixture() {
  local fixture_local="$FIXTURES_DIR/silence-500ms.pcm"
  local cache_path="/data/user/0/$ANDROID_APP/cache/sentient-fixture.pcm"
  info "  Pushing fixture to app cache: $cache_path"
  cat "$fixture_local" | adb -s "$ANDROID_DEVICE" shell "run-as $ANDROID_APP sh -c 'cat > $cache_path'" 2>/dev/null \
    || info "  WARNING: fixture push via run-as failed"
  adb -s "$ANDROID_DEVICE" shell am broadcast -a io.sentient.debug.FAULT -p "$ANDROID_APP" --es kind fixture --es name sentient-fixture.pcm 2>/dev/null || true
  sleep 1
}

grep_logcat_for() {
  local pattern="$1"; local label="$2"; local count
  count=$(adb -s "$ANDROID_DEVICE" logcat -d 2>/dev/null | grep -cE "$pattern" || true)
  if [[ "$count" -ge 1 ]]; then pass "  logcat: $count '$label' events"; return 0
  else fail "  logcat: no '$label' (pattern: $pattern)"; return 1; fi
}

# -- Batch runner --------------------------------------------------------------
# Deterministic order is enforced HERE (not by Maestro): Maestro's flowsOrder
# breaks --include-tags and its default folder order is non-deterministic, so the
# runner resolves the selected tags into an explicit, canonically-ordered file
# list and runs it as ONE warm `maestro test f1 f2 ... fN` invocation (JVM amortised
# once; restore pairs stay adjacent; logout last; continue-on-failure is default
# for a multi-file run so restores execute even if a primary failed).
#
# CANONICAL_ORDER is the single source of truth for order (mirrors the taxonomy in
# config.yaml's comment). Both platforms iterate it; any tag-matching flow present
# in the dir but NOT named here is appended (sorted) so a platform that names flows
# differently still runs everything.
CANONICAL_ORDER=(
  login
  verify-newchat
  01-chat-send 01-send-stream 02-drawer 03-new-chat 05-interrupt
  06-switch-session 07-rename-delete 10-outbox 11-mic-control
  40-settings-root
  44-audio-fast-save 44b-audio-restore
  45-model-slow-save 45b-model-restore
  46-memory-cap 47-system-prompt-restore-default
  48-advanced-sliders 48b-advanced-restore
  49-tools-toggle 49b-tools-restore
  50-personalities-create-activate 59-audio-dirty-back-discard
  51-account-rename 51b-account-restore 52-pin-wrong-current
  54-voice-preview-pick 54b-voice-restore
  55-voice-create-record 55b-voice-delete-user-pack
  62-fish-clone-happy 62b-fish-clone-cleanup
  57-diagnostics-send 58-update-footer-check
  56-secrets-presence 41-members-add-cap 42-settings-non-admin-gate 43-members-delete-cleanup
  63-logout
  04-reconnect 04b-reconnect-recover
  04c-reconnect-continue-login-send 04c-reconnect-continue-followup
  08-voice-loop 18-auth-expired 20-malformed-frame 58b-update-footer-offline
  60-model-offline-save-setup 60-model-offline-save-trigger 60-model-offline-save-recover
  61-apply-conflict-setup 61-apply-conflict-trigger
)

# flow_tags <file> - echo the flow's tags, one per line (reads the YAML header).
flow_tags() {
  awk '/^---[[:space:]]*$/{exit}
       /^tags:/{t=1;next}
       t && /^[[:space:]]*-[[:space:]]/{gsub(/^[[:space:]]*-[[:space:]]*/,"");gsub(/[[:space:]]+$/,"");print;next}
       t && /^[^[:space:]#]/{t=0}' "$1"
}

# flow_matches <file> - true if the flow passes the current include/exclude filter.
# Uses if-guards (not `grep && return`) so a trailing non-match never trips set -e.
flow_matches() {
  local tags; tags=$(flow_tags "$1")
  local IFS=','
  local x inc
  for x in $EFFECTIVE_EXCLUDE; do
    if grep -qx "$x" <<<"$tags"; then return 1; fi
  done
  [[ -z "$INCLUDE_TAGS" ]] && return 0
  for inc in $INCLUDE_TAGS; do
    if grep -qx "$inc" <<<"$tags"; then return 0; fi
  done
  return 1
}

BATCH_RESULT=0
EFFECTIVE_EXCLUDE="$BASE_EXCLUDE"
run_batch() {
  local platform="$1"; local device="$2"
  local dir="$FLOWS_DIR/$platform"
  EFFECTIVE_EXCLUDE="$BASE_EXCLUDE"
  [[ -n "$EXTRA_EXCLUDE" ]] && EFFECTIVE_EXCLUDE="$EFFECTIVE_EXCLUDE,$EXTRA_EXCLUDE"

  # Build the ordered, tag-filtered file list. (bash 3.2: no associative arrays,
  # so track seen names in a space-delimited string.)
  local -a selected=()
  local seen=" "
  local name f
  for name in "${CANONICAL_ORDER[@]}"; do
    f="$dir/$name.yaml"
    [[ -f "$f" ]] || continue
    if flow_matches "$f"; then selected+=("$f"); seen="$seen$name "; fi
  done
  # Append any tag-matching flows not in CANONICAL_ORDER (platform-specific names).
  for f in "$dir"/*.yaml; do
    name=$(basename "$f" .yaml)
    if [[ "$name" == "config" || "$seen" == *" $name "* ]]; then continue; fi
    if flow_matches "$f"; then selected+=("$f"); fi
  done

  echo ""
  info "Batch: $platform  include=[${INCLUDE_TAGS:-<all>}]  exclude=[$EFFECTIVE_EXCLUDE]"
  if [[ ${#selected[@]} -eq 0 ]]; then
    flag "  No flows match the filter on $platform - nothing to run."
    return
  fi
  info "  ${#selected[@]} flows (ordered): $(for f in "${selected[@]}"; do basename "$f" .yaml; done | tr '\n' ' ')"

  local out; out=$(mktemp)
  local start end elapsed
  start=$(date +%s)
  set +e
  # Explicit ordered files (deterministic). --exclude-tags helper is belt-and-braces
  # (helpers live in _helpers/ and are never in the resolved list anyway).
  "$MAESTRO" --device "$device" test -e "QA_USER_ID=$QA_USER_ID" "${selected[@]}" --exclude-tags helper 2>&1 | tee "$out"
  local rc=${PIPESTATUS[0]}
  set -e
  end=$(date +%s); elapsed=$((end - start))

  local n_pass n_fail n_total
  n_pass=$(grep -cE "^\[Passed\]" "$out" || true)
  n_fail=$(grep -cE "^\[Failed\]" "$out" || true)
  n_total=$((n_pass + n_fail))
  echo ""
  info "-- Batch timing ($platform) --"
  info "  flows run     : $n_total  (passed=$n_pass failed=$n_fail)"
  info "  wall time     : ${elapsed}s"
  if [[ "$n_total" -gt 0 ]]; then
    info "  per-flow avg  : $((elapsed / n_total))s   (vs old ~42-65s FIXED cost PER cold invocation)"
  fi
  rm -f "$out"
  [[ "$rc" -eq 0 ]] || BATCH_RESULT=1
  [[ "$n_fail" -eq 0 ]] || BATCH_RESULT=1
}

# -- Post-batch log-trail assertions (Android default run) ---------------------
# The old per-flow greps (streaming delta, mic start, outbox flush) become one
# post-batch sweep over logcat ? the batch already exercised those flows.
android_log_trail() {
  echo ""
  info "Log-trail assertions (logcat sweep)"
  grep_logcat_for "MessageDelta|message\.delta" "MessageDelta (streaming, 01-send-stream)" || BATCH_RESULT=1
  grep_logcat_for "startMic|stopMic" "startMic/stopMic (11-mic-control)" || flag "  mic log trail absent (hold-to-talk mic may not emit on a plain tap)"
  grep_logcat_for "pendingSend|flush" "pendingSend/flush (10-outbox)" || flag "  outbox flush trail absent"
}

# -- Fault-armed phase (Android only) ------------------------------------------
run_flow_file() { # <device> <platform> <basename> ; returns maestro rc
  "$MAESTRO" --device "$1" test -e "QA_USER_ID=$QA_USER_ID" "$FLOWS_DIR/$2/$3.yaml"
}
run_one() { run_flow_file "$ANDROID_DEVICE" android "$1"; }   # android fault phase

fault_phase_android() {
  echo ""
  info "=== Fault-armed phase (individual runs with arming) ==="
  local dir="$FLOWS_DIR/android"

  # 20-malformed-frame ? arm on the RUNNING app, then run (no relaunch).
  echo ""; info "-> 20-malformed-frame"
  adb -s "$ANDROID_DEVICE" logcat -c 2>/dev/null || true
  arm_fault "malformed"
  if run_one "20-malformed-frame"; then pass "  20-malformed-frame"; sleep 1
    grep_logcat_for "fault\.malformed-frame|decode-failed" "decode-failed" || BATCH_RESULT=1
  else fail "  20-malformed-frame"; BATCH_RESULT=1; fi

  # 08-voice-loop ? push fixture + arm, then run.
  echo ""; info "-> 08-voice-loop"
  adb -s "$ANDROID_DEVICE" logcat -c 2>/dev/null || true
  push_and_arm_fixture
  if run_one "08-voice-loop"; then pass "  08-voice-loop"; sleep 1
    grep_logcat_for "fixture-utterance" "fixture-utterance" || BATCH_RESULT=1
    grep_logcat_for "startMic" "startMic" || BATCH_RESULT=1
    flag "  08-voice-loop: FULL STT->LLM->TTS needs a real speech fixture (silence only here)"
  else fail "  08-voice-loop"; BATCH_RESULT=1; fi

  # 58b-update-footer-offline ? self-navigating; kill net around it.
  echo ""; info "-> 58b-update-footer-offline (network kill)"
  adb -s "$ANDROID_DEVICE" shell svc wifi disable 2>/dev/null || true
  adb -s "$ANDROID_DEVICE" shell svc data disable 2>/dev/null || true
  if run_one "58b-update-footer-offline"; then pass "  58b-update-footer-offline"; else fail "  58b-update-footer-offline"; BATCH_RESULT=1; fi
  adb -s "$ANDROID_DEVICE" shell svc wifi enable 2>/dev/null || true
  adb -s "$ANDROID_DEVICE" shell svc data enable 2>/dev/null || true

  # 60-model-offline ? setup (online) -> kill net -> trigger -> restore net -> recover.
  echo ""; info "-> 60-model-offline-save (setup -> kill -> trigger -> recover)"
  if run_one "60-model-offline-save-setup"; then
    adb -s "$ANDROID_DEVICE" shell svc wifi disable 2>/dev/null || true
    adb -s "$ANDROID_DEVICE" shell svc data disable 2>/dev/null || true
    run_one "60-model-offline-save-trigger" && pass "  60 trigger (offline save failed inline)" || { fail "  60 trigger"; BATCH_RESULT=1; }
    adb -s "$ANDROID_DEVICE" shell svc wifi enable 2>/dev/null || true
    adb -s "$ANDROID_DEVICE" shell svc data enable 2>/dev/null || true
    sleep 3
    run_one "60-model-offline-save-recover" && pass "  60 recover (+ model restored)" || { fail "  60 recover"; BATCH_RESULT=1; }
  else fail "  60 setup"; BATCH_RESULT=1; fi

  # 61-apply-conflict ? setup, then a concurrent curl apply raced against the tap.
  echo ""; info "-> 61-apply-conflict (setup -> concurrent apply -> trigger)"
  if run_one "61-apply-conflict-setup"; then
    flag "  61 trigger needs the curl-race + adb-tap variant (see flow header) ? running trigger as ordinary-path re-validation"
    run_one "61-apply-conflict-trigger" && pass "  61 trigger" || { fail "  61 trigger"; BATCH_RESULT=1; }
  else fail "  61 setup"; BATCH_RESULT=1; fi

  # 18-auth-expired ? arm expired + stop gateway -> run -> restart gateway.
  echo ""; info "-> 18-auth-expired (arm expired + gateway stop)"
  adb -s "$ANDROID_DEVICE" logcat -c 2>/dev/null || true
  arm_fault "expired"
  info "  Stopping gateway to force reconnect"
  gw_stop_or_flag
  if run_one "18-auth-expired"; then pass "  18-auth-expired"; sleep 1
    grep_logcat_for "fault\.expired-token|hasSession\.clear" "expired-token / hasSession.clear" || BATCH_RESULT=1
  else fail "  18-auth-expired"; BATCH_RESULT=1; fi
  info "  Restarting gateway"
  gw_start_or_flag
  # 18 left the app on the login screen ? log back in so the device is usable after.
  run_one "login" >/dev/null 2>&1 || true

  # 04-reconnect ? emulator can't drop WiFi (physical-only). Flag; skip on emulator.
  echo ""; info "-> 04-reconnect"
  if [[ "$ANDROID_DEVICE" == emulator-* ]]; then
    flag "  04-reconnect SKIPPED (emulator uses virtual Ethernet; WiFi toggle is a no-op). Needs a physical device or a gateway stop (gw_stop_or_flag)."
  else
    flag "  04-reconnect on a physical device: disable WiFi, run 04, re-enable, run 04b (not automated here)."
  fi

  # 04c warm-continuity ? airplane-mode toggle between the two parts.
  echo ""; info "-> 04c warm-reconnect continuity (airplane toggle between parts)"
  if run_one "04c-reconnect-continue-login-send"; then
    info "  airplane-mode ON (drop WS) ..."
    adb -s "$ANDROID_DEVICE" shell cmd connectivity airplane-mode enable 2>/dev/null || true
    sleep 12
    adb -s "$ANDROID_DEVICE" shell cmd connectivity airplane-mode disable 2>/dev/null || true
    sleep 3
    # tap the "Connection lost. Tap to reconnect" banner for a WARM reconnect.
    local banner_tap; banner_tap=$(mktemp /tmp/e2e-banner.XXXX.yaml)
    printf 'appId: io.dev32.sentient.debug\n---\n- tapOn:\n    id: "connection-reconnect"\n    optional: true\n' > "$banner_tap"
    "$MAESTRO" --device "$ANDROID_DEVICE" test "$banner_tap" >/dev/null 2>&1 || true
    rm -f "$banner_tap"
    run_one "04c-reconnect-continue-followup" && pass "  04c continuity" || { fail "  04c continuity"; flag "  verify gateway log: dispatch.end conversationId unchanged, NO dispatch.session-new.lazy"; BATCH_RESULT=1; }
  else fail "  04c part 1"; BATCH_RESULT=1; fi
}

# -- Fault-armed phase (iOS) ---------------------------------------------------
# iOS has no adb-broadcast fault channel, so the broadcast faults (08/18/20) are
# Android-only. iOS fault-armed flows are gateway-stop orchestrated instead.
run_ios_one() { run_flow_file "$IOS_DEVICE" ios "$1"; }

fault_phase_ios() {
  echo ""; info "=== iOS fault-armed phase (gateway-stop orchestration) ==="
  flag "  08/18/20 broadcast faults are Android-only (no adb-broadcast channel on iOS) - skipped."

  # 58b-update-footer-offline: gateway DOWN -> "Check failed".
  echo ""; info "-> 58b-update-footer-offline (gateway stop)"
  gw_stop_or_flag
  run_ios_one "58b-update-footer-offline" && pass "  58b-update-footer-offline" || { fail "  58b-update-footer-offline"; BATCH_RESULT=1; }
  gw_start_or_flag

  # 60-model-offline-save: setup while UP -> stop -> trigger -> start -> recover.
  echo ""; info "-> 60-model-offline-save (setup up -> stop -> trigger -> start -> recover)"
  if run_ios_one "60-model-offline-save-setup"; then
    gw_stop_or_flag
    run_ios_one "60-model-offline-save-trigger" && pass "  60 trigger" || { fail "  60 trigger"; BATCH_RESULT=1; }
    gw_start_or_flag
    run_ios_one "60-model-offline-save-recover" && pass "  60 recover" || { fail "  60 recover"; BATCH_RESULT=1; }
  else fail "  60 setup"; BATCH_RESULT=1; fi

  # 04c warm-continuity: login-send -> restart the native gateway (between) -> followup.
  echo ""; info "-> 04c warm-reconnect continuity (gateway restart between parts)"
  if run_ios_one "04c-reconnect-continue-login-send"; then
    gw_restart_or_flag
    run_ios_one "04c-reconnect-continue-followup" && pass "  04c continuity" || { fail "  04c continuity"; flag "  verify gateway log: dispatch.end conversationId unchanged, NO dispatch.session-new.lazy"; BATCH_RESULT=1; }
  else fail "  04c part 1"; BATCH_RESULT=1; fi
}

# -- Main ----------------------------------------------------------------------
echo ""
echo "===== Sentient Mobile E2E Harness (batch) ====="
echo "Target: $TARGET   tags: [${INCLUDE_TAGS:-<all>}]   fault: $RUN_FAULT"
echo ""

check_gateway
check_qa_user
if should_reset_gateway; then reset_gateway; fi
BATCH_RESULT=0

run_android_target() {
  check_android
  setup_android
  if [[ "$RUN_FAULT" != "only" ]]; then
    run_batch android "$ANDROID_DEVICE"
    [[ -z "$INCLUDE_TAGS" ]] && android_log_trail
  fi
  # Fault phase: on a default (no --tags) run unless --no-fault, or when --fault-only.
  if [[ "$RUN_FAULT" == "only" ]] || { [[ "$RUN_FAULT" == "auto" ]] && [[ -z "$INCLUDE_TAGS" ]]; }; then
    fault_phase_android
  fi
}

run_ios_target() {
  check_ios
  setup_ios
  # iOS flows carry the same tag taxonomy + filenames (refactored to match). Same
  # tag->ordered-explicit-files batch path as Android.
  if [[ "$RUN_FAULT" != "only" ]]; then
    run_batch ios "$IOS_DEVICE"
  fi
  if [[ "$RUN_FAULT" == "only" ]] || { [[ "$RUN_FAULT" == "auto" ]] && [[ -z "$INCLUDE_TAGS" ]]; }; then
    fault_phase_ios
  fi
}

case "$TARGET" in
  android) run_android_target ;;
  ios)     run_ios_target ;;
  all)     run_android_target; run_ios_target ;;
  *) echo "$USAGE"; exit 1 ;;
esac

echo ""
if [[ "$BATCH_RESULT" -eq 0 ]]; then pass "All selected flows GREEN"; else fail "One or more flows FAILED ? see above"; fi
exit "$BATCH_RESULT"
