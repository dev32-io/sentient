"""Live test for the Chatterbox MLX streaming engine.

This is the one test in the service that touches the real model: it
downloads (first run only, ~3-4 GB, cached under
``~/.cache/huggingface``) and loads the deployed default Chatterbox
weights, then drives a real streaming synthesis. Marked
``@pytest.mark.live`` and excluded from the default ``uv run pytest``
run (see ``pyproject.toml``'s ``addopts``) — run explicitly with
``uv run pytest tests/test_chatterbox_mlx.py -v -m live``.

Model id note: the deployed default is the **Turbo** variant
(``mlx-community/Chatterbox-Turbo-TTS-8bit``), not the plain
``Chatterbox-TTS-8bit`` id used in ``config.example.yaml`` (that
example id is kept non-Turbo so config-parsing tests never need
network access — see that file's comments). This test validates
against the real deployed default so it actually exercises the
``chatterbox_turbo`` streaming code path the engine wraps.
"""

from __future__ import annotations

import threading

import numpy as np
import pytest

from chatterbox_tts.chatterbox_mlx import SAMPLE_RATE, ChatterboxEngine

_MODEL_ID = "mlx-community/Chatterbox-Turbo-TTS-8bit"
_MIN_AUDIO_SECONDS = 0.5


@pytest.mark.live
def test_streams_pcm_chunks():
    eng = ChatterboxEngine(_MODEL_ID, 0.5, 0.5)
    eng.warm()

    chunks = list(
        eng.synthesize(
            "Hello there, this is a test.",
            eng.default_conditionals(),
            0.5,
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
    eng = ChatterboxEngine(_MODEL_ID, 0.5, 0.5)
    eng.warm()

    cancel = threading.Event()
    cancel.set()

    chunks = list(
        eng.synthesize(
            "This sentence should never finish synthesizing because we cancel first.",
            eng.default_conditionals(),
            0.5,
            cancel,
        )
    )

    assert chunks == []
