"""Live test for the Qwen3-TTS MLX streaming engine.

This is the one test module that touches the real Qwen3-TTS model: it
loads the already-downloaded (per the TTS-swap evaluation bench)
``mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit`` weights, cached under
``~/.cache/huggingface``, then drives real streaming synthesis on both
the default-voice path and the reference-audio voice-cloning path.
Marked ``@pytest.mark.live`` and excluded from the default
``uv run pytest`` run (see ``pyproject.toml``'s ``addopts``) — run
explicitly with ``uv run pytest -m live -k qwen -q``.
"""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import pytest

from local_tts.engine import SAMPLE_RATE, QwenEngine

_MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"
_MIN_AUDIO_SECONDS = 0.5
# Repo-root-relative reference clip reused from the PoC bench
# (pocs/localTTS/ref.wav) — resolved from this file's path so the test
# passes regardless of the pytest invocation's working directory.
_REF_AUDIO_PATH = str(
    Path(__file__).resolve().parents[3] / "pocs" / "localTTS" / "ref.wav"
)


@pytest.mark.live
def test_streams_pcm_chunks_default_voice_zh():
    """No ref audio + auto lang detect on Chinese text -> real audio."""
    eng = QwenEngine(_MODEL_ID)
    eng.warm()

    chunks = list(
        eng.synthesize(
            "你好，有什么可以帮您？",
            None,
            "auto",
            2.0,
            threading.Event(),
        )
    )

    assert len(chunks) >= 1
    audio = np.concatenate(chunks)
    assert audio.dtype == np.float32
    assert len(audio) / SAMPLE_RATE > _MIN_AUDIO_SECONDS  # produced real audio


@pytest.mark.live
def test_streams_pcm_chunks_with_ref_audio_clone():
    """Reference-audio voice cloning (no ref_text) on English text."""
    eng = QwenEngine(_MODEL_ID)
    eng.warm()

    chunks = list(
        eng.synthesize(
            "Hello there, this is a cloning test.",
            _REF_AUDIO_PATH,
            "auto",
            2.0,
            threading.Event(),
        )
    )

    assert len(chunks) >= 1
    audio = np.concatenate(chunks)
    assert audio.dtype == np.float32
    assert len(audio) / SAMPLE_RATE > _MIN_AUDIO_SECONDS  # produced real audio


@pytest.mark.live
def test_cancel_stops_streaming_early():
    """A cancel event set before synthesis starts yields zero chunks."""
    eng = QwenEngine(_MODEL_ID)
    eng.warm()

    cancel = threading.Event()
    cancel.set()

    chunks = list(
        eng.synthesize(
            "This sentence should never finish synthesizing because we cancel first.",
            None,
            "auto",
            2.0,
            cancel,
        )
    )

    assert chunks == []
