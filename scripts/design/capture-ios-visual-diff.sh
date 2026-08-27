#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
source scripts/env.sh

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <reference.png> [output.png]" >&2
  exit 2
fi

reference="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
case_id="$(basename "$reference" .png)"
output="${2:-$repo_root/build/visual-captures/ios/$case_id.png}"
mkdir -p "$(dirname "$output")" "$repo_root/build/visual-ios-derived"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"

reference_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$reference")"
output_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$output")"
output_root_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$repo_root/build/visual-captures/ios")"
if [[ "$output_real" == "$reference_real" || "$output_real" != "$output_root_real/"* ]]; then
  echo "iOS implementation output must stay under build/visual-captures/ios and must not overwrite the reference." >&2
  exit 2
fi
if [[ ! -f "$reference" ]]; then
  echo "Reference does not exist: $reference" >&2
  exit 2
fi

if [[ -n "${VISUAL_DIFF_IOS_DESTINATION:-}" ]]; then
  destination="$VISUAL_DIFF_IOS_DESTINATION"
else
  booted_ids="$(xcrun simctl list devices booted | sed -nE '/iPhone 16 \(/ s/.*\(([0-9A-F-]{36})\) \(Booted\).*/\1/p')"
  booted_count="$(printf '%s\n' "$booted_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$booted_count" != "1" ]]; then
    echo "Boot exactly one iPhone 16 simulator or set VISUAL_DIFF_IOS_DESTINATION (found $booted_count)." >&2
    exit 2
  fi
  destination="platform=iOS Simulator,id=$booted_ids"
fi
if [[ "$destination" != *"iOS Simulator"* ]]; then
  echo "Visual diff capture supports iOS Simulator destinations only." >&2
  exit 2
fi

request_file="/tmp/sentient-visual-diff-request"
lock_dir="/tmp/sentient-visual-diff-capture.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another iOS visual capture is active, or $lock_dir is stale." >&2
  exit 2
fi
cleanup() { rm -f "$request_file"; rmdir "$lock_dir" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
printf '%s\n%s\n%s\n' "$reference" "$output" "$repo_root" > "$request_file"
rm -f "$output"

xcodebuild test \
  -project ios/SentientApp.xcodeproj \
  -scheme SentientApp \
  -configuration Debug \
  -destination "$destination" \
  -derivedDataPath "$repo_root/build/visual-ios-derived" \
  -only-testing:SentientAppTests/VisualDiffCaptureTests/testCaptureRequestedReference \
  -parallel-testing-enabled NO

if [[ ! -f "$output" ]]; then
  echo "iOS visual capture did not produce $output" >&2
  exit 2
fi

printf '{"platform":"ios","caseId":"%s","actualPath":"%s"}\n' "$case_id" "$output"
