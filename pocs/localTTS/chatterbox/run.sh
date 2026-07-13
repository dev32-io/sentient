#!/usr/bin/env bash
# Chatterbox-TTS speed bench — full-precision + q8. No args: ./run.sh
# QUALITY KING — 0.5B, zero-shot cloning, blind-beats ElevenLabs. Clones ../ref.wav.
set -euo pipefail
cd "$(dirname "$0")"

VARIANTS=(
  "mlx-community/Chatterbox-TTS-fp16|fp16"
  "mlx-community/Chatterbox-TTS-8bit|8bit"
)

for v in "${VARIANTS[@]}"; do
  IFS='|' read -r model label <<< "$v"
  echo "### chatterbox $label — $model"
  uv run --no-project --with-requirements requirements.txt \
    python ../bench.py --model "$model" --gen-file gen.json --sr 24000 --out "out/$label" "$@"
done
