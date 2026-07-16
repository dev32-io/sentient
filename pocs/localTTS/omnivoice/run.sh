#!/usr/bin/env bash
# OmniVoice speed bench — full-precision + q8. No args: ./run.sh
# NEW find (k2-fsa, Mar 2026): Apache-2.0, ~40x realtime, zero-shot cloning, 600+ langs.
# Clones ../ref.wav (+ ref_text) — OmniVoice has no built-in preset, always reference-based.
set -euo pipefail
cd "$(dirname "$0")"

VARIANTS=(
  "mlx-community/OmniVoice-bf16|bf16"
  # 8bit repo has mismatched quant weights ("199 parameters not in model") — skip.
)

for v in "${VARIANTS[@]}"; do
  IFS='|' read -r model label <<< "$v"
  echo "### omnivoice $label — $model"
  uv run --no-project --with-requirements requirements.txt \
    python ../bench.py --model "$model" --gen-file gen.json --sr 24000 --out "out/$label" "$@"
done
