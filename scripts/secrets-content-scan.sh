#!/usr/bin/env bash
# Scans staged diffs for known secret-shaped strings.
# Allow-list: lines with `# allow-secret: <reason>` trailing comment.
# Path-allowlist: gateway/test/fixtures/ excluded via pathspec (content is test data).
set -euo pipefail

PATTERNS=(
  'sk-or-[a-zA-Z0-9]{32,}'
  'sk-ant-[a-zA-Z0-9-]{32,}'
  'sk-[a-zA-Z0-9]{20,}'
  'fa[-_][a-zA-Z0-9]{20,}'
  'v4\.local\.[A-Za-z0-9_-]{40,}'
  'Bearer[[:space:]]+[A-Za-z0-9_=-]{40,}'
  # JWT shape: header.payload.signature — catches HA/MA long-lived tokens
  # that may not be prefixed with `Bearer `.
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'
  # Android keystore password committed as a real base64-ish literal (≥16 chars).
  # Narrow on purpose: only the base64 alphabet [A-Za-z0-9+/] is matched, so $VAR
  # refs, FAKE_ placeholders, and passwords with special chars (!@#$…) won't trip it.
  # That's fine — the keystore generator emits `openssl rand -base64` (pure base64,
  # caught), and the gitignore + filename-block layers are the primary guards.
  '(store|key)Password[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{16,}={0,2}([[:space:]]|$)'
)

DIFF=$(git diff --cached -U0 -- ':!gateway/test/fixtures/**')
[ -z "$DIFF" ] && exit 0

VIOLATIONS=""
for p in "${PATTERNS[@]}"; do
  hits=$(echo "$DIFF" | grep -nE "^\+" | grep -E "$p" | grep -v "# allow-secret:" | grep -v "FAKE_" || true)
  if [ -n "$hits" ]; then
    VIOLATIONS="$VIOLATIONS\nPattern: $p\n$hits"
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo -e "🚨 Possible secret leaked in staged diff:\n$VIOLATIONS" >&2
  echo "Add '# allow-secret: <reason>' on the line if intentional." >&2
  exit 1
fi
exit 0
