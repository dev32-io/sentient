#!/usr/bin/env bash
# Remove the HuggingFace-cached TTS models pulled by the localTTS PoCs (frees several GB).
# Surgical: only the repos these PoCs download — leaves the rest of your HF cache alone.
# Run AFTER benchmarking:  ./cleanup.sh
set -uo pipefail

HUB="$HOME/.cache/huggingface/hub"
echo "=== HF hub cache before ==="; du -sh "$HUB" 2>/dev/null || true

PATTERNS=(
  "models--mlx-community--Kokoro-82M-*"
  "models--mlx-community--Chatterbox-*"     # standard + Turbo variants
  "models--ResembleAI--chatterbox*"         # 3GB base pulled by mlx-audio's Chatterbox
  "models--mlx-community--Qwen3-TTS-*"
  "models--mlx-community--OmniVoice-*"
  "models--mlx-community--Voxtral-*"
)

freed=0
for p in "${PATTERNS[@]}"; do
  for d in "$HUB"/$p; do
    [ -e "$d" ] || continue
    sz=$(du -sh "$d" | cut -f1)
    echo "rm  $sz  $(basename "$d")"
    rm -rf "$d"
  done
done

echo "=== HF hub cache after ==="; du -sh "$HUB" 2>/dev/null || true
echo "done. (uv env cache left intact; run 'uv cache clean' if you also want the Python wheels gone.)"
