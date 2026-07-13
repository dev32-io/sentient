#!/usr/bin/env bash
# Voxtral-TTS speed bench — bf16 + 4bit. No args: ./run.sh
# NEW find (Mistral, Mar 2026): beat ElevenLabs Flash 68% on cloning. 4B — expect SLOW on
# the mini's GPU. Default voice (gen.json empty); if it needs a voice name, that's a follow-up.
set -euo pipefail
cd "$(dirname "$0")"

VARIANTS=(
  "mlx-community/Voxtral-4B-TTS-2603-mlx-bf16|bf16"
  "mlx-community/Voxtral-4B-TTS-2603-mlx-4bit|4bit"
)

for v in "${VARIANTS[@]}"; do
  IFS='|' read -r model label <<< "$v"
  echo "### voxtral $label — $model"
  uv run --no-project --with-requirements requirements.txt \
    python ../bench.py --model "$model" --gen-file gen.json --sr 24000 --out "out/$label" "$@"
done
