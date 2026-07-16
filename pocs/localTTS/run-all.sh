#!/usr/bin/env bash
# Run every localTTS PoC (all options × variants) sequentially, then aggregate.
# Sequential = clean numbers (no GPU contention). Tolerant: a failing option does not
# stop the rest — check RESULTS.md + each option's stdout for what landed.
#   ./run-all.sh
set -uo pipefail
cd "$(dirname "$0")"

OPTIONS=(kokoro chatterbox qwen3tts omnivoice voxtral)

for opt in "${OPTIONS[@]}"; do
  echo ""
  echo "===================== $opt ====================="
  if [ -x "$opt/run.sh" ]; then
    ( cd "$opt" && ./run.sh ) || echo "!!! $opt FAILED (continuing to next)"
  else
    echo "!!! $opt/run.sh missing or not executable — skipping"
  fi
done

echo ""
echo "===================== aggregate ====================="
python3 aggregate.py
