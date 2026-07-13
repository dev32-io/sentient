"""Chatterbox TTS via MLX (Apple Silicon / Metal) — model holder + streaming synth.

Wraps ``mlx_audio``'s Chatterbox-Turbo model (``chatterbox_turbo.py``,
read from the installed venv while writing this module) behind a small
service-facing API: load once, warm once, then stream 24 kHz float32
PCM chunks per synthesis call.

Model loading: ``_load_model`` is module-level and ``@lru_cache``'d by
``model_id``, so multiple ``ChatterboxEngine`` instances constructed
with the same ``model_id`` share one warm in-memory model — same
pattern as the sibling STT service's ``ModelHolder``
(``WhisperSTTService/src/whisper_stt/whisper_mlx.py``). Weights are
fetched from HuggingFace on first use and cached under
``~/.cache/huggingface``.

Conditioning ("conds"): unlike the assumed shape in the original task
sketch, ``ChatterboxTurboTTS.generate()``/``stream_generate()`` do NOT
take a ``conds=`` keyword — the real API reads voice conditioning off
the model's own ``model._conds`` attribute (a ``Conditionals``
dataclass with ``.t3``/``.gen`` fields), set once at load time by
``ChatterboxTurboTTS.post_load_hook`` from the repo's
``conds.safetensors`` (this is also the attribute ``prepare_conditionals()``
writes to for voice-cloning). So ``synthesize()`` here honors its own
``conds`` parameter by assigning it onto ``model._conds`` immediately
before calling ``generate()`` when a caller-supplied ``conds`` is given,
and leaves the model's built-in load-time conditionals untouched when
``conds`` is ``None``. ``default_conditionals()`` simply reads that same
attribute back.
"""

from __future__ import annotations

import logging
import threading
import time
from functools import lru_cache
from typing import Iterator

import mlx.core as mx
import numpy as np
from mlx_audio.tts.utils import load_model

log = logging.getLogger("chatterbox_tts.chatterbox_mlx")

# Output sample rate of Chatterbox-Turbo's S3Gen vocoder. Matches
# ``ChatterboxTurboTTS.sr`` (see chatterbox_turbo.py) — not configurable,
# it's a property of the model architecture, not a service tunable.
SAMPLE_RATE = 24_000

# Short, fixed text used by warm() to force a real end-to-end pass
# (tokenizer -> T3 -> S3Gen) once at startup, so the first real request
# doesn't pay for lazy Metal-kernel / cache warmup.
_WARM_TEXT = "Warming up."
_WARM_STREAMING_INTERVAL = 0.5


@lru_cache(maxsize=None)
def _load_model(model_id: str):
    """Load (and cache) the MLX Chatterbox model for ``model_id``.

    Cached at module level so every ``ChatterboxEngine`` constructed
    with the same ``model_id`` shares one loaded model instead of
    re-downloading/re-loading weights per instance.
    """
    log.info("chatterbox_mlx.model_load start model_id=%s", model_id)
    t0 = time.monotonic()
    model = load_model(model_id)
    elapsed_ms = (time.monotonic() - t0) * 1000.0
    log.info(
        "chatterbox_mlx.model_load done model_id=%s elapsed_ms=%.1f",
        model_id, elapsed_ms,
    )
    return model


def _chunk_to_pcm(audio: mx.array) -> np.ndarray:
    """Evaluate one generated chunk and convert it to 1-D float32 PCM."""
    mx.eval(audio)
    return np.asarray(audio, dtype=np.float32).reshape(-1)


def _prepare_chunk(result, chunk_index: int, model_id: str) -> np.ndarray:
    """Convert one ``GenerationResult`` to PCM and log the per-chunk decision.

    Isolates the convert+log step so ``synthesize()`` stays a thin
    control-flow loop; mirrors how ``_chunk_to_pcm`` isolates the pure
    MLX->numpy conversion.
    """
    pcm = _chunk_to_pcm(result.audio)
    log.debug(
        "chatterbox_mlx.synthesize chunk model_id=%s chunk_idx=%d samples=%d "
        "is_final_chunk=%s",
        model_id, chunk_index, pcm.size, result.is_final_chunk,
    )
    return pcm


class ChatterboxEngine:
    """One (model_id, exaggeration, cfg_weight) view over the MLX Chatterbox model.

    Construction is cheap — the actual model load is deferred to first
    use (``warm()`` or ``synthesize()``) and shared across instances via
    ``_load_model``'s cache.

    Thread-safety hazard: ``_load_model`` is an ``lru_cache``'d module-level
    singleton, so every ``ChatterboxEngine`` for a given ``model_id`` shares
    one underlying model object. ``synthesize()`` honors a caller-supplied
    ``conds`` by mutating that shared model's ``model._conds`` in place
    before calling ``generate()``. Two concurrent ``synthesize()`` calls on
    the same ``model_id`` with different ``conds`` therefore race on
    ``model._conds`` — one call's conditioning can silently leak into or
    override another's, producing wrong-voice output with no error. This
    class does not serialize itself; callers (the WS server) MUST serialize
    synthesis per ``model_id`` — e.g. one worker/lock per model — or hold
    the engine for the full duration of a request.
    """

    def __init__(self, model_id: str, exaggeration: float, cfg_weight: float) -> None:
        self._model_id = model_id
        self._exaggeration = exaggeration
        self._cfg_weight = cfg_weight

    def warm(self) -> None:
        """Force the model to load and run one short synthesis end-to-end."""
        for _ in self.synthesize(
            _WARM_TEXT,
            self.default_conditionals(),
            _WARM_STREAMING_INTERVAL,
            threading.Event(),
        ):
            pass
        log.info("chatterbox_mlx.warm done model_id=%s", self._model_id)

    def default_conditionals(self) -> object | None:
        """The model's built-in conds, loaded from ``conds.safetensors`` at load time."""
        model = _load_model(self._model_id)
        return getattr(model, "_conds", None)

    def prepare_conditionals(self, ref_wav: np.ndarray, sr: int) -> object:
        """Build voice conditioning ``Conditionals`` from a reference clip.

        NOT thread-safe: like ``synthesize()``'s caller-supplied-``conds``
        path, this calls the shared ``_load_model``-cached model's own
        ``prepare_conditionals()``, which sets ``model._conds`` as a side
        effect (see the class docstring). Returns that same object so
        callers (``VoiceStore.create()``) can persist it without reaching
        into ``model._conds`` themselves.
        """
        log.debug(
            "chatterbox_mlx.prepare_conditionals start model_id=%s samples=%d sr=%d",
            self._model_id, ref_wav.size, sr,
        )
        model = _load_model(self._model_id)
        model.prepare_conditionals(ref_wav, sample_rate=sr)
        log.info(
            "chatterbox_mlx.prepare_conditionals done model_id=%s samples=%d sr=%d",
            self._model_id, ref_wav.size, sr,
        )
        return model._conds

    def synthesize(
        self,
        text: str,
        conds: object | None,
        streaming_interval: float,
        cancel: threading.Event,
    ) -> Iterator[np.ndarray]:
        """Stream 24 kHz float32 PCM chunks for ``text``. ``conds`` overrides
        the model's built-in voice conditioning when given (``None`` keeps
        the model's current conds). Checks ``cancel`` between chunks,
        returning early without yielding the in-flight chunk.
        """
        model = _load_model(self._model_id)
        if conds is not None:
            # NOT thread-safe: mutates the shared lru_cache'd model singleton — see class docstring.
            model._conds = conds
        chunk_count = 0
        total_samples = 0
        for result in model.generate(
            text,
            exaggeration=self._exaggeration,
            cfg_weight=self._cfg_weight,
            stream=True,
            streaming_interval=streaming_interval,
        ):
            if cancel.is_set():
                log.debug(
                    "chatterbox_mlx.synthesize cancelled model_id=%s chunk_count=%d",
                    self._model_id, chunk_count,
                )
                return
            chunk_count += 1
            pcm = _prepare_chunk(result, chunk_count, self._model_id)
            total_samples += pcm.size
            yield pcm
        log.debug(
            "chatterbox_mlx.synthesize done model_id=%s chunk_count=%d total_samples=%d",
            self._model_id, chunk_count, total_samples,
        )
