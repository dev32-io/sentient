"""Download Smart-Turn v3.2 CPU ONNX weights from Hugging Face.

Runs at Docker build time so the image is self-contained and the first
WebSocket connection is not blocked on a network fetch.

Usage:
    python download_model.py <destination_dir>

The file is placed at <destination_dir>/smart-turn-v3.2-cpu.onnx (~8.7 MB).
"""

import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

REPO_ID = "pipecat-ai/smart-turn-v3"
FILENAME = "smart-turn-v3.2-cpu.onnx"


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: download_model.py <destination_dir>", file=sys.stderr)
        sys.exit(2)

    dest_dir = Path(sys.argv[1]).resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)

    print(f"[download_model] fetching {REPO_ID}/{FILENAME} -> {dest_dir}")
    local_path = hf_hub_download(
        repo_id=REPO_ID,
        filename=FILENAME,
        local_dir=str(dest_dir),
    )
    size_mb = Path(local_path).stat().st_size / (1024 * 1024)
    print(f"[download_model] done: {local_path} ({size_mb:.2f} MiB)")


if __name__ == "__main__":
    main()
