"""Qwen3-TTS via MLX (Apple Silicon / Metal) — model holder + streaming synth.

Wraps ``mlx_audio``'s Qwen3-TTS model (``mlx_audio.tts.models.qwen3_tts``)
behind a small service-facing shape: load once, warm once, then stream
24 kHz float32 PCM chunks per synthesis call. This is the multilingual
(en/zh via ``lang_code="auto"``) engine that backs the ``local_tts``
service.

Voice cloning: Qwen3-TTS clones directly off a reference wav path (or
``mx.array``) passed as ``ref_audio`` on every ``generate()`` call —
there is no separate "prepare" step and no persisted conditioning
object to manage. Passing ``ref_audio=None`` uses the model's built-in
default voice. ``ref_text`` is optional (used only for the model's
in-context-learning clone path) and is intentionally never passed here
— none of this project's reference clips ship a transcript, and
``ref_audio``-only cloning was verified to produce good audio on a
bench script during evaluation.

Model loading: ``_load_model`` is module-level and ``@lru_cache``'d by
``model_id``, mirroring the sibling STT service's ``ModelHolder``
(``WhisperSTTService/src/whisper_stt/whisper_mlx.py``). Weights are
fetched from HuggingFace on first use and cached under
``~/.cache/huggingface``.
"""

from __future__ import annotations

import logging
import threading
import time
from functools import lru_cache
from typing import Iterator

import numpy as np
from mlx_audio.tts.utils import load_model

log = logging.getLogger("local_tts.engine")

# Qwen3-TTS's native output rate (Hz) — a property of the model
# architecture (its vocoder), not a service tunable. Verified against a
# real streaming ``generate()`` call during the TTS-swap evaluation bench.
SAMPLE_RATE = 24_000

# Short, fixed text + interval used by warm() to force a real end-to-end
# pass (tokenizer -> talker -> vocoder) once at startup, so the first
# real request doesn't pay for lazy Metal-kernel / cache warmup.
_WARM_TEXT = "Warming up."
_WARM_STREAMING_INTERVAL = 2.0


@lru_cache(maxsize=None)
def _load_model(model_id: str):
    """Load (and cache) the MLX Qwen3-TTS model for ``model_id``.

    Cached at module level so every ``QwenEngine`` constructed with the
    same ``model_id`` shares one loaded model instead of
    re-downloading/re-loading weights per instance.
    """
    log.info("engine.model_load start model_id=%s", model_id)
    t0 = time.monotonic()
    model = load_model(model_id)
    elapsed_ms = (time.monotonic() - t0) * 1000.0
    log.info(
        "engine.model_load done model_id=%s elapsed_ms=%.1f",
        model_id, elapsed_ms,
    )
    return model


def _prepare_chunk(result) -> np.ndarray:
    """Convert one ``GenerationResult`` to 1-D float32 PCM and log its size."""
    pcm = np.asarray(result.audio, dtype=np.float32).reshape(-1)
    log.debug(
        "engine.synthesize chunk samples=%d is_final_chunk=%s",
        pcm.size, getattr(result, "is_final_chunk", None),
    )
    return pcm


def _log_synthesize_start(
    model_id: str,
    text: str,
    ref_audio_path: str | None,
    lang_code: str,
    streaming_interval: float,
) -> None:
    """Log the synthesize entry decision — ids/lengths/booleans only, never text."""
    log.debug(
        "engine.synthesize start model_id=%s text_len=%d has_ref_audio=%s "
        "lang_code=%s streaming_interval=%.2f",
        model_id, len(text), ref_audio_path is not None, lang_code,
        streaming_interval,
    )


class QwenEngine:
    """One (model_id, default_lang) view over the MLX Qwen3-TTS model.

    Construction is cheap — the actual model load is deferred to first
    use (``warm()`` or ``synthesize()``) and shared across instances via
    ``_load_model``'s cache.

    There is no shared mutable conditioning state to race on: every
    ``synthesize()`` call passes its own ``ref_audio`` straight through
    to ``generate()`` as a plain argument, so concurrent calls on the
    same ``model_id`` with different reference clips do not interfere
    with each other.
    """

    def __init__(self, model_id: str, default_lang: str = "auto") -> None:
        self._model_id = model_id
        self._default_lang = default_lang

    def warm(self) -> None:
        """Force the model to load, then run one short synthesis end-to-end."""
        _load_model(self._model_id)
        for _ in self.synthesize(
            _WARM_TEXT,
            None,
            self._default_lang,
            _WARM_STREAMING_INTERVAL,
            threading.Event(),
        ):
            pass
        log.info("engine.warm done model_id=%s", self._model_id)

    def synthesize(
        self,
        text: str,
        ref_audio_path: str | None,
        lang_code: str,
        streaming_interval: float,
        cancel: threading.Event,
    ) -> Iterator[np.ndarray]:
        """Stream 24 kHz float32 PCM chunks for ``text``. ``ref_audio_path=None``
        uses the model's default voice; otherwise clones from that wav path.
        Checks ``cancel`` between chunks, returning early without yielding it.
        """
        model = _load_model(self._model_id)
        _log_synthesize_start(
            self._model_id, text, ref_audio_path, lang_code, streaming_interval
        )
        chunk_count = 0
        total_samples = 0
        for result in model.generate(
            text,
            ref_audio=ref_audio_path,
            lang_code=lang_code,
            stream=True,
            streaming_interval=streaming_interval,
        ):
            if cancel.is_set():
                log.debug(
                    "engine.synthesize cancelled model_id=%s chunk_count=%d",
                    self._model_id, chunk_count,
                )
                return
            chunk_count += 1
            pcm = _prepare_chunk(result)
            total_samples += pcm.size
            yield pcm
        log.debug(
            "engine.synthesize done model_id=%s chunk_count=%d total_samples=%d",
            self._model_id, chunk_count, total_samples,
        )
