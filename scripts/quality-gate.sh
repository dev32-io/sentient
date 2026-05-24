#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=env.sh
source "$REPO_ROOT/scripts/env.sh"

SCOPE="${1:-all}"  # lint | typecheck | test | all

# ─── Platform runners ───
run_ts_lint()      { bun run lint; }
run_ts_typecheck() { bun run typecheck; }
run_ts_test()      { bun run test:unit; }

# Phase 6: replace stubs with real commands
# run_android_lint() { cd android && ./gradlew lint; }
# run_android_test() { cd android && ./gradlew test; }
# run_ios_lint()     { cd ios && fastlane lint; }
# run_ios_test()     { cd ios && fastlane test; }

# ─── Run by scope ───
case "$SCOPE" in
  lint)      run_ts_lint ;;
  typecheck) run_ts_typecheck ;;
  test)      run_ts_test ;;
  all)       run_ts_lint && run_ts_typecheck && run_ts_test ;;
  *) echo "Unknown scope: $SCOPE" >&2; exit 1 ;;
esac
