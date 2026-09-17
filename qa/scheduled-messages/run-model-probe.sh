#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${SCHEDULE_QA_TARGET:-https://localhost:8888}"
OUTPUT="${1:?usage: run-model-probe.sh OUTPUT_JSON [GATEWAY_LOG]}"
GATEWAY_LOG="${2:-}"
: "${SCHEDULE_QA_ADMIN_USER_ID:?required disposable-fixture admin id}"
: "${SCHEDULE_QA_ADMIN_PIN:?required disposable-fixture admin pin}"
: "${SCHEDULE_QA_USER_PIN:?required four-digit disposable user pin}"
: "${SCHEDULE_QA_PROMPT:?required synthetic ordinary-chat scheduling request}"

STATE="$(mktemp -t sentient-schedule-probe).json"
cleanup() {
  DESIGN_REFRESH_ADMIN_USER_ID="$SCHEDULE_QA_ADMIN_USER_ID" \
  DESIGN_REFRESH_ADMIN_PIN="$SCHEDULE_QA_ADMIN_PIN" \
  DESIGN_REFRESH_ENVIRONMENT=local \
    bun "$REPO/qa/design-refresh/fixture-control.ts" cleanup --target "$TARGET" --state "$STATE" >/dev/null || true
  rm -f "$STATE"
}
trap cleanup EXIT

DESIGN_REFRESH_ADMIN_USER_ID="$SCHEDULE_QA_ADMIN_USER_ID" \
DESIGN_REFRESH_ADMIN_PIN="$SCHEDULE_QA_ADMIN_PIN" \
DESIGN_REFRESH_USER_PIN="$SCHEDULE_QA_USER_PIN" \
DESIGN_REFRESH_ENVIRONMENT=local \
  bun "$REPO/qa/design-refresh/fixture-control.ts" provision --target "$TARGET" --state "$STATE" >/dev/null
USER_ID="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).userId)' "$STATE")"

ARGS=(--target "$TARGET" --user-id "$USER_ID" --output "$OUTPUT")
[[ -z "$GATEWAY_LOG" ]] || ARGS+=(--gateway-log "$GATEWAY_LOG")
cd "$REPO"
bun qa/scheduled-messages/model-scheduling-probe.ts "${ARGS[@]}"
