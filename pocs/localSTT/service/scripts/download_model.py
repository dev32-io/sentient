"""Download Smart-Turn v3.2 CPU ONNX + SenseVoice-Small int8 ONNX weights.

Runs at Docker build time so the image is self-contained and the first
WebSocket connection is not blocked on a network fetch.

Layout produced under <destination_dir>:

    smart-turn/
        smart-turn-v3.2-cpu.onnx                (~8.7 MB)
    sense-voice/
        model.int8.onnx                         (~229 MB)
        tokens.txt                              (~300 KB)

Usage:
    python download_model.py <destination_dir>
"""

import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

# --- Smart-Turn ------------------------------------------------------------

SMART_TURN_REPO = "pipecat-ai/smart-turn-v3"
SMART_TURN_FILENAME = "smart-turn-v3.2-cpu.onnx"

# --- SenseVoice (via csukuangfj's sherpa-onnx mirror) ----------------------

SENSE_VOICE_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
SENSE_VOICE_FILES = [
    "model.int8.onnx",
    "tokens.txt",
]


def _mib(p: Path) -> str:
    return f"{p.stat().st_size / (1024 * 1024):.2f} MiB"


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: download_model.py <destination_dir>", file=sys.stderr)
        sys.exit(2)

    dest_dir = Path(sys.argv[1]).resolve()
    smart_turn_dir = dest_dir / "smart-turn"
    sense_voice_dir = dest_dir / "sense-voice"
    smart_turn_dir.mkdir(parents=True, exist_ok=True)
    sense_voice_dir.mkdir(parents=True, exist_ok=True)

    print(f"[download_model] fetching {SMART_TURN_REPO}/{SMART_TURN_FILENAME}")
    smart_turn_path = Path(
        hf_hub_download(
            repo_id=SMART_TURN_REPO,
            filename=SMART_TURN_FILENAME,
            local_dir=str(smart_turn_dir),
        )
    )
    print(f"[download_model]   -> {smart_turn_path} ({_mib(smart_turn_path)})")

    for filename in SENSE_VOICE_FILES:
        print(f"[download_model] fetching {SENSE_VOICE_REPO}/{filename}")
        local_path = Path(
            hf_hub_download(
                repo_id=SENSE_VOICE_REPO,
                filename=filename,
                local_dir=str(sense_voice_dir),
            )
        )
        print(f"[download_model]   -> {local_path} ({_mib(local_path)})")

    print("[download_model] all models ready")


if __name__ == "__main__":
    main()
