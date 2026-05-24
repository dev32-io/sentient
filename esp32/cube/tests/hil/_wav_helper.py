"""Shared WAV → base64 PCM helper for sentient HIL tests.

The `audio.inject_pcm` verb takes a base64-encoded raw PCM16 payload
(see firmware/components/agent_console/verbs/audio_inject.cc:92,231).
The single-payload chunk cap is 32 KB b64. Fixture clips must stay
under that — they do today (see fixtures/*.wav).
"""
from __future__ import annotations

import base64
import wave


def load_wav_as_pcm_b64(path: str) -> str:
    """Load 16 kHz mono PCM16 WAV and return base64 of raw PCM frames."""
    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 1, f"{path} is not mono"
        assert w.getsampwidth() == 2, f"{path} is not 16-bit"
        assert w.getframerate() == 16000, f"{path} is not 16 kHz"
        raw = w.readframes(w.getnframes())
    return base64.b64encode(raw).decode("ascii")
