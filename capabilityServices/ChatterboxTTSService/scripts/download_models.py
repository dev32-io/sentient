"""Warm/pre-fetch the Chatterbox MLX model weights for the native
chatterbox-tts service.

mlx-audio resolves the ``model`` id from config.yaml via
``mlx_audio.utils.get_model_path()`` at first synthesis request
(``chatterbox_mlx.py``'s ``_load_model``), which downloads through
huggingface_hub's ``snapshot_download`` into the standard
``~/.cache/huggingface`` hub cache — mlx-audio does not accept a custom
``cache_dir``. This script calls that exact same resolver at *install*
time (rather than reimplementing the download with a different allow-list
that could drift from mlx-audio's own) so a multi-hundred-MB-to-GB HF
download happens once, up front, instead of on the LaunchAgent's first
cold start or the gateway's first real TTS request.

Unlike Whisper-STT's Smart-Turn ONNX sidecar, there is no separate small
artifact to fetch here — the built-in default reference voice ships
inside the model repo itself (``conds.safetensors``, read by
``ChatterboxTurboTTS.post_load_hook`` at load time). The model bytes
therefore land in the shared HF hub cache, not under <destination_dir>;
this script writes a small receipt there instead, recording the resolved
local snapshot path, so an operator can confirm what's warm under
~/.sentient/chatterbox-tts/models/ without knowing HuggingFace's internal
cache layout.

Usage:
    python scripts/download_models.py <destination_dir> [model_id]
"""

from __future__ import annotations

import sys
from pathlib import Path

from mlx_audio.utils import get_model_path

# Matches the deployed Turbo default seeded into config.yaml by
# deploy/mac-prod/native/chatterbox-tts.sh's install step. Used when the
# caller doesn't pass an explicit model_id override.
DEFAULT_MODEL_ID = "mlx-community/Chatterbox-Turbo-TTS-8bit"


def main() -> None:
    if len(sys.argv) not in (2, 3):
        print("usage: download_models.py <destination_dir> [model_id]", file=sys.stderr)
        sys.exit(2)

    dest_dir = Path(sys.argv[1]).resolve()
    model_id = sys.argv[2] if len(sys.argv) == 3 else DEFAULT_MODEL_ID
    dest_dir.mkdir(parents=True, exist_ok=True)

    print(f"[download_models] fetching {model_id}")
    model_path = get_model_path(model_id)
    print(f"[download_models]   -> {model_path}")

    receipt = dest_dir / f"{model_id.replace('/', '--')}.txt"
    receipt.write_text(f"{model_path}\n", encoding="utf-8")
    print(f"[download_models]   receipt -> {receipt}")
    print("[download_models] model ready")


if __name__ == "__main__":
    main()
