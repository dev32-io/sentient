#!/usr/bin/env bash
# Kokoro-82M speed bench — full-precision + q8. No args: ./run.sh
# Speed REFERENCE — tiny 82M, no voice cloning (fixed voice packs).
set -euo pipefail
cd "$(dirname "$0")"

VARIANTS=(
  "mlx-community/Kokoro-82M-bf16|bf16"
  "mlx-community/Kokoro-82M-8bit|8bit"
)

for v in "${VARIANTS[@]}"; do
  IFS='|' read -r model label <<< "$v"
  echo "### kokoro $label — $model"
  uv run --no-project --with-requirements requirements.txt \
    python ../bench.py --model "$model" --gen-file gen.json --sr 24000 --out "out/$label" "$@"
done
