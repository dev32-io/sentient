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
output="${2:-$repo_root/build/visual-captures/android/$case_id.png}"
mkdir -p "$(dirname "$output")"
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"

reference_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$reference")"
output_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$output")"
output_root_real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$repo_root/build/visual-captures/android")"
if [[ "$output_real" == "$reference_real" || "$output_real" != "$output_root_real/"* ]]; then
  echo "Android implementation output must stay under build/visual-captures/android and must not overwrite the reference." >&2
  exit 2
fi
if [[ ! -f "$reference" ]]; then
  echo "Reference does not exist: $reference" >&2
  exit 2
fi
if [[ "$case_id" != "action-button--destructive--rest" ]]; then
  echo "No lean Android visual capture fixture exists yet for $case_id" >&2
  exit 2
fi

rendered_root="$repo_root/android/build/outputs/screenshotTest-results/preview/debug/rendered"
results_xml="$repo_root/android/build/test-results/validateDebugScreenshotTest/TEST-preview-screenshot-test-engine.xml"
log="$repo_root/build/visual-captures/android/gradle-capture.log"
rm -rf "$rendered_root"
rm -f "$results_xml"
set +e
./gradlew \
  -PvisualDiffAndroid=true \
  -Pandroid.experimental.enableScreenshotTest=true \
  :android:validateDebugScreenshotTest >"$log" 2>&1
gradle_status=$?
set -e

rendered="$(find "$rendered_root" -type f -name "*${case_id}*.png" -print 2>/dev/null | head -n 1)"
if [[ -z "$rendered" || ! -f "$rendered" ]]; then
  cat "$log" >&2
  echo "Android screenshot testing did not render $case_id (Gradle exit $gradle_status)" >&2
  exit 2
fi
if [[ "$gradle_status" != "0" ]]; then
  if ! python3 - "$results_xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
errors = root.findall(".//error")
valid = (
    root.attrib.get("tests") == "1"
    and root.attrib.get("failures") == "0"
    and root.attrib.get("errors") == "1"
    and len(errors) == 1
    and errors[0].attrib.get("type") == "com.android.tools.screenshot.differ.ScreenshotImageNotFoundException"
)
raise SystemExit(0 if valid else 1)
PY
  then
    cat "$log" >&2
    echo "Android screenshot validation failed unexpectedly (Gradle exit $gradle_status)" >&2
    exit 2
  fi
fi
cp "$rendered" "$output"

printf '{"platform":"android","caseId":"%s","actualPath":"%s"}\n' "$case_id" "$output"
