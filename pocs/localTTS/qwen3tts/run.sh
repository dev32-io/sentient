#!/usr/bin/env bash
# Qwen3-TTS-0.6B speed bench — full-precision + q8. No args: ./run.sh
# Streaming wildcard — Apache-2.0, 3s-reference cloning, description control. Voice preset.
set -euo pipefail
cd "$(dirname "$0")"

VARIANTS=(
  "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16|bf16"
  "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit|8bit"
)

for v in "${VARIANTS[@]}"; do
  IFS='|' read -r model label <<< "$v"
  echo "### qwen3tts $label — $model"
  uv run --no-project --with-requirements requirements.txt \
    python ../bench.py --model "$model" --gen-file gen.json --sr 24000 --out "out/$label" "$@"
done
