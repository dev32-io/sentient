"""Phase-2 test gate: mp3 -> WS -> transcript.

Decodes an audio file to 16 kHz PCM16 mono via ffmpeg, streams it to a locally-
running Whisper-STT over the WebSocket, then asserts the transcript contains the
expected substring. Also streams trailing silence to trigger vad_end ->
Smart-Turn -> transcript_ready.

Usage:
    python scripts/ws_smoke.py \
        --url ws://127.0.0.1:8768 \
        --mp3 ~/Development/record-weather.mp3 \
        --expect weather
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
from pathlib import Path

import websockets

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512  # Silero chunk granularity
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 mono
TAIL_SILENCE_MS = 2000  # trailing silence to trigger end-of-turn
RECV_TIMEOUT_S = 30.0


def decode_to_pcm16(src: Path) -> bytes:
    """ffmpeg-decode any audio file to raw PCM16 LE mono @ 16 kHz."""
    cmd = [
        "ffmpeg", "-nostdin", "-loglevel", "error",
        "-i", str(src),
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
    ]
    return subprocess.run(cmd, capture_output=True, check=True).stdout


async def run(url: str, src: Path, expect: str) -> int:
    pcm = decode_to_pcm16(src)
    silence = b"\x00\x00" * (SAMPLE_RATE * TAIL_SILENCE_MS // 1000)
    stream = pcm + silence

    async with websockets.connect(url, max_size=None) as ws:
        ready = json.loads(await ws.recv())
        if ready.get("type") != "ready":
            print(f"[smoke] FAIL: expected ready, got {ready}", file=sys.stderr)
            return 1
        print(f"[smoke] ready: stt={ready.get('stt')} sr={ready.get('sampleRate')}")

        async def send_audio() -> None:
            for i in range(0, len(stream), FRAME_BYTES):
                await ws.send(stream[i:i + FRAME_BYTES])
                await asyncio.sleep(0.004)

        sender = asyncio.create_task(send_audio())
        transcript: str | None = None
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT_S)
                if isinstance(msg, (bytes, bytearray)):
                    continue  # WAV binary frame
                evt = json.loads(msg)
                etype = evt.get("type")
                if etype in ("transcript_ready", "turn_rejected", "vad_start", "vad_end"):
                    print(f"[smoke] evt: {etype} text={evt.get('text', '')!r}")
                if etype == "transcript_ready":
                    transcript = evt.get("text", "")
                    break
        finally:
            sender.cancel()

    if transcript is None:
        print("[smoke] FAIL: no transcript_ready received", file=sys.stderr)
        return 1
    ok = expect.lower() in transcript.lower()
    print(f"[smoke] transcript: {transcript!r}")
    print(f"[smoke] {'PASS' if ok else 'FAIL'}: expected substring {expect!r}")
    return 0 if ok else 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8768")
    ap.add_argument("--mp3", default=str(Path.home() / "Development" / "record-weather.mp3"))
    ap.add_argument("--expect", default="weather")
    args = ap.parse_args()
    sys.exit(asyncio.run(run(args.url, Path(args.mp3), args.expect)))


if __name__ == "__main__":
    main()
