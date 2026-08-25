#!/usr/bin/env bash
# Design-refresh-only Maestro path for E2E-006..009. Deliberately has no
# permission grant, microphone/audio flow, gateway fault phase, or connectivity mutation.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=scripts/env.sh
source scripts/env.sh

CASE="${1:-}"
[[ "$CASE" =~ ^E2E-00[6-9]$ ]] || { echo "usage: $0 E2E-006..E2E-009" >&2; exit 2; }
TARGET="${DESIGN_REFRESH_BASE_URL:-https://localhost/}"
MAESTRO="${MAESTRO:-$HOME/.maestro/bin/maestro}"
IOS_APP="io.dev32.sentient.debug"
IOS_DEVICE="${IOS_DEVICE:-$(xcrun simctl list devices booted 2>/dev/null | grep -oE '[0-9A-Fa-f-]{36}' | head -1)}"
[[ -n "$IOS_DEVICE" ]] || { echo "a booted iOS simulator is required" >&2; exit 2; }
[[ -x "$MAESTRO" ]] || { echo "Maestro is required at $MAESTRO" >&2; exit 2; }
bun -e 'import {assertLoopbackFixtureTarget} from "./qa/design-refresh/fixture.ts"; assertLoopbackFixtureTarget(process.argv[1], "local")' "$TARGET"

APP_PATH="$(xcrun simctl get_app_container "$IOS_DEVICE" "$IOS_APP" app 2>/dev/null || true)"
[[ -n "$APP_PATH" ]] || { echo "install the local signed debug app before running design-refresh E2E" >&2; exit 2; }
codesign --verify --deep --strict "$APP_PATH" 2>/dev/null || { echo "installed simulator app does not pass signed-build verification" >&2; exit 2; }

FLOW="$REPO_ROOT/qa/mobile/flows/ios/design-refresh/${CASE}.yaml"
[[ -f "$FLOW" ]] || { echo "missing targeted flow $FLOW" >&2; exit 2; }
if grep -Eiq 'microphone|record_audio|simctl[[:space:]]+privacy|fault-armed|airplane|wi-?fi|svc[[:space:]]+(wifi|data)|gateway[[:space:]_-]*(stop|restart)' "$FLOW"; then
  echo "targeted iOS flow violates the text-only/no-fault boundary" >&2
  exit 1
fi

STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sentient-design-refresh-ios.XXXXXX")"
USER_STATE="$STATE_DIR/user.json"
CALENDAR_STATE="$STATE_DIR/calendar.json"
ORIGINAL_TEXT_SIZE="$(xcrun simctl ui "$IOS_DEVICE" content_size 2>/dev/null | awk '{print $NF}' | tr -d '[:space:]' || true)"
cleanup() {
  local rc=$? cleanup_rc=0
  set +e
  if [[ -n "$ORIGINAL_TEXT_SIZE" ]]; then xcrun simctl ui "$IOS_DEVICE" content_size "$ORIGINAL_TEXT_SIZE" >/dev/null 2>&1 || cleanup_rc=1; fi
  if [[ -f "$CALENDAR_STATE" ]]; then bun run calendar:fixture cleanup --target "$TARGET" --state "$CALENDAR_STATE" || cleanup_rc=1; fi
  if [[ -f "$USER_STATE" ]]; then bun qa/design-refresh/fixture-control.ts cleanup --target "$TARGET" --state "$USER_STATE" || cleanup_rc=1; fi
  rm -rf "$STATE_DIR"
  if [[ "$rc" -ne 0 ]]; then exit "$rc"; fi
  exit "$cleanup_rc"
}
trap cleanup EXIT INT TERM

export DESIGN_REFRESH_TEXT_ONLY=1
# The targeted login helper enters this synthetic disposable PIN without ever
# writing it under an evidence root.
[[ "${DESIGN_REFRESH_USER_PIN:?required disposable user PIN}" == "1234" ]] || { echo "iOS targeted flows require the synthetic PIN 1234" >&2; exit 2; }
export DESIGN_REFRESH_EVIDENCE_ROOT="$REPO_ROOT/qa/mobile/evidence/design-refresh"
if [[ "$CASE" == "E2E-009" ]]; then
  bun run calendar:fixture provision --target "$TARGET" --state "$CALENDAR_STATE"
  export DESIGN_REFRESH_USER_ID="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).adultId)' "$CALENDAR_STATE")"
  export DESIGN_REFRESH_USER_PIN="${CALENDAR_E2E_ADULT_PIN:?required for disposable Calendar user}"
  [[ "$DESIGN_REFRESH_USER_PIN" == "1234" ]] || { echo "Calendar targeted flow requires the synthetic adult PIN 1234" >&2; exit 2; }
  export DESIGN_REFRESH_CALENDAR_STATE="$CALENDAR_STATE"
else
  bun qa/design-refresh/fixture-control.ts provision --target "$TARGET" --state "$USER_STATE"
  export DESIGN_REFRESH_USER_ID="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).userId)' "$USER_STATE")"
fi

if [[ "$CASE" == "E2E-008" ]]; then
  xcrun simctl ui "$IOS_DEVICE" content_size accessibility-extra-extra-extra-large
fi
"$MAESTRO" --device "$IOS_DEVICE" test -e "QA_USER_ID=$DESIGN_REFRESH_USER_ID" "$FLOW"
