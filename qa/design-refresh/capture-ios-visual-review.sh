#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEVICE="${IOS_VISUAL_DEVICE:-DB6D8CAF-B12E-44CA-87EB-6A0DD51FFA75}"
BUILT="/tmp/sentient-visual-derived/Build/Products/Debug-iphonesimulator/SentientApp.app"
EVIDENCE="$ROOT/qa/mobile/evidence/design-refresh"
PAGE_COUNT="$(jq '[.rows[] | select(.platform == "ios")] | length | ((. + 2) / 3 | floor)' "$ROOT/qa/design-refresh/inventory.json")"
mkdir -p "$EVIDENCE"
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
xcrun simctl install "$DEVICE" "$BUILT"
codesign --verify --deep --strict "$BUILT"
xcrun simctl ui "$DEVICE" appearance dark
ORIGINAL_SIZE="$(xcrun simctl ui "$DEVICE" content_size | tail -1 | tr -d '[:space:]')"
cleanup() { xcrun simctl ui "$DEVICE" content_size "$ORIGINAL_SIZE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

capture_config() {
  local config="$1" size="$2"
  xcrun simctl ui "$DEVICE" content_size "$size" >/dev/null
  for page in $(seq 0 $((PAGE_COUNT - 1))); do
    xcrun simctl launch --terminate-running-process "$DEVICE" io.dev32.sentient.debug --qa-visual-review --qa-visual-page "$page" --qa-visual-config "$config" >/dev/null
    local ready=0
    for _ in $(seq 1 50); do
      if maestro --device "$DEVICE" hierarchy 2>/dev/null | grep -q "qa-visual-review-page-$page"; then ready=1; break; fi
      sleep .1
    done
    [[ "$ready" == 1 ]] || { echo "catalog page $page did not become observable" >&2; exit 1; }
    xcrun simctl io "$DEVICE" screenshot "$EVIDENCE/${config}-page-$(printf '%02d' $((page + 1))).png" >/dev/null
  done
}

capture_config ios-iphone-standard large
capture_config ios-iphone-ax3 accessibility-extra-large
capture_config ios-reduced-motion large

python3 - "$ROOT" <<'PY'
import json,sys
from pathlib import Path
root=Path(sys.argv[1]); rows=[r for r in json.load(open(root/'qa/design-refresh/inventory.json'))['rows'] if r['platform']=='ios']
for page in range((len(rows)+2)//3):
 page_rows=rows[page*3:(page+1)*3]
 captures=[]
 for config in ['ios-iphone-standard','ios-iphone-ax3','ios-reduced-motion']:
  captures.append({'configuration':config,'path':f'qa/mobile/evidence/design-refresh/{config}-page-{page+1:02d}.png'})
 def has_target(state):
  import re
  value=state.lower()
  return not re.search(r'loading|saving|applying|submitting|installing|checking|running|thinking|empty|no sessions|no match',value) or bool(re.search(r'error|failed|denied|conflict|unavailable|offline|stale',value))
 observations=[{'inventoryId':r['id'],'configuration':c['configuration'],'overflow':0,'minimumTarget':44 if has_target(r['state']) else None,'focusableCount':1 if has_target(r['state']) else 0} for r in page_rows for c in captures]
 doc={'version':1,'kind':'design-refresh-visual-evidence','platform':'ios','inventoryIds':[r['id'] for r in page_rows],'captures':captures,'observations':observations}
 (root/f'qa/mobile/evidence/design-refresh/page-{page+1:02d}.json').write_text(json.dumps(doc,indent=2)+'\n')
PY
