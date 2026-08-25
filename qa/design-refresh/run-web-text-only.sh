#!/usr/bin/env bash
# Targeted driver for E2E-001..005. It provisions only disposable loopback data;
# the browser implementation is supplied by DESIGN_REFRESH_WEB_DRIVER.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=scripts/env.sh
source scripts/env.sh

CASE="${1:-}"
[[ "$CASE" =~ ^E2E-00[1-5]$ ]] || { echo "usage: $0 E2E-001..E2E-005" >&2; exit 2; }
TARGET="${DESIGN_REFRESH_BASE_URL:-https://localhost/}"
DRIVER="${DESIGN_REFRESH_WEB_DRIVER:-}"
[[ -n "$DRIVER" && -x "$DRIVER" ]] || { echo "DESIGN_REFRESH_WEB_DRIVER must name an executable text-only browser driver" >&2; exit 2; }
bun -e 'import {assertLoopbackFixtureTarget} from "./qa/design-refresh/fixture.ts"; assertLoopbackFixtureTarget(process.argv[1], "local")' "$TARGET"

STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sentient-design-refresh-web.XXXXXX")"
USER_STATE="$STATE_DIR/user.json"
CALENDAR_STATE="$STATE_DIR/calendar.json"
cleanup() {
  local rc=$? cleanup_rc=0
  set +e
  if [[ -f "$CALENDAR_STATE" ]]; then bun run calendar:fixture cleanup --target "$TARGET" --state "$CALENDAR_STATE" || cleanup_rc=1; fi
  if [[ -f "$USER_STATE" ]]; then bun qa/design-refresh/fixture-control.ts cleanup --target "$TARGET" --state "$USER_STATE" || cleanup_rc=1; fi
  rm -rf "$STATE_DIR"
  if [[ "$rc" -ne 0 ]]; then exit "$rc"; fi
  exit "$cleanup_rc"
}
trap cleanup EXIT INT TERM

export DESIGN_REFRESH_TEXT_ONLY=1
export DESIGN_REFRESH_EVIDENCE_ROOT="$REPO_ROOT/qa/web/evidence/design-refresh"
if [[ "$CASE" == "E2E-004" ]]; then
  bun run calendar:fixture provision --target "$TARGET" --state "$CALENDAR_STATE"
  export DESIGN_REFRESH_USER_ID="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).adultId)' "$CALENDAR_STATE")"
  export DESIGN_REFRESH_USER_PIN="${CALENDAR_E2E_ADULT_PIN:?required for disposable Calendar user}"
  export DESIGN_REFRESH_CALENDAR_STATE="$CALENDAR_STATE"
else
  bun qa/design-refresh/fixture-control.ts provision --target "$TARGET" --state "$USER_STATE"
  export DESIGN_REFRESH_USER_ID="$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).userId)' "$USER_STATE")"
fi

"$DRIVER" --case "$CASE" --base-url "$TARGET" --matrix "$REPO_ROOT/qa/design-refresh/e2e-matrix.json"
