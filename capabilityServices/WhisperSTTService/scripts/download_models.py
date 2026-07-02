"""Download Smart-Turn v3.2 CPU ONNX weights for the native Whisper-STT service.

Whisper weights are fetched by mlx_whisper from HuggingFace at runtime (cached
under ~/.cache/huggingface); Silero VAD is fetched by torch.hub. Only Smart-Turn
needs a pre-fetch into the model dir.

Layout produced under <destination_dir>:
    smart-turn/
        smart-turn-v3.2-cpu.onnx                (~8.7 MB)

Usage:
    python scripts/download_models.py <destination_dir>
"""

import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

SMART_TURN_REPO = "pipecat-ai/smart-turn-v3"
SMART_TURN_FILENAME = "smart-turn-v3.2-cpu.onnx"


def _mib(p: Path) -> str:
    return f"{p.stat().st_size / (1024 * 1024):.2f} MiB"


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: download_models.py <destination_dir>", file=sys.stderr)
        sys.exit(2)

    dest_dir = Path(sys.argv[1]).resolve()
    smart_turn_dir = dest_dir / "smart-turn"
    smart_turn_dir.mkdir(parents=True, exist_ok=True)

    print(f"[download_models] fetching {SMART_TURN_REPO}/{SMART_TURN_FILENAME}")
    smart_turn_path = Path(
        hf_hub_download(
            repo_id=SMART_TURN_REPO,
            filename=SMART_TURN_FILENAME,
            local_dir=str(smart_turn_dir),
        )
    )
    print(f"[download_models]   -> {smart_turn_path} ({_mib(smart_turn_path)})")
    print("[download_models] all models ready")


if __name__ == "__main__":
    main()
