"""SenseVoice-Small STT via sherpa-onnx.

Returns text + timing plus the SenseVoice acoustic classifier outputs:
``emotion`` (NEUTRAL / HAPPY / ANGRY / ...) and ``event`` (Speech /
Laughter / BGM / ...).

Language parameter:
  ``language`` is a decode hint that configures the recognizer's
  language-selection branch in sherpa-onnx. ``"auto"`` runs the internal
  classifier and transcribes code-switched speech correctly; ``"en"`` /
  ``"zh"`` force the chosen language for higher accuracy on short
  utterances that confuse auto-detect. The param is baked into the
  recognizer at construction — to change it, build a new ``SenseVoice``
  instance. See ``server.py`` for the per-connection language registry.

Python note — sherpa_onnx:
  ``sherpa-onnx`` is a C++ inference engine with Python bindings. It
  ships pre-built wheels for x86_64 and aarch64, so ``pip install``
  just works on both your dev machine and the Raspberry Pi. The Python
  API is thin: create a recognizer, create a stream, feed audio, read
  the result. All the heavy lifting happens in C++ behind the scenes.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import sherpa_onnx

from .config import SenseVoiceConfig

# Protocol constants — fixed by the model architecture.
SAMPLE_RATE = 16_000
MODEL_FILENAME = "model.int8.onnx"
TOKENS_FILENAME = "tokens.txt"

# Valid ``language`` values accepted by the sherpa-onnx SenseVoice
# recognizer we build here. Kept to the household-supported set rather
# than everything SenseVoice knows (ja / ko / yue are trained but not
# exposed on the gateway side).
VALID_LANGUAGES: tuple[str, ...] = ("auto", "en", "zh")


@dataclass
class TranscriptResult:
    """Outcome of a single SenseVoice decode."""

    text: str
    emotion: str  # e.g. "<|NEUTRAL|>", "<|HAPPY|>" — tag-wrapped
    event: str  # e.g. "<|Speech|>", "<|Laughter|>" — tag-wrapped
    decode_ms: float
    audio_seconds: float


class SenseVoice:
    """Wraps a single sherpa-onnx OfflineRecognizer for SenseVoice-Small.

    One instance = one configured ``language``. To switch language mid-
    service, construct a new instance (the ONNX weights are loaded per
    instance — count on ~450 MB RSS per language, caller's decision
    whether to cache).
    """

    def __init__(
        self,
        model_dir: Path,
        *,
        config: SenseVoiceConfig,
        language: str = "auto",
    ) -> None:
        if language not in VALID_LANGUAGES:
            raise ValueError(
                f"SenseVoice: unsupported language {language!r}; "
                f"must be one of {VALID_LANGUAGES}"
            )
        model_path = model_dir / MODEL_FILENAME
        tokens_path = model_dir / TOKENS_FILENAME
        if not model_path.is_file():
            raise FileNotFoundError(
                f"SenseVoice model not found at {model_path}. "
                "Did scripts/download_models.py run at image build time?"
            )
        if not tokens_path.is_file():
            raise FileNotFoundError(
                f"SenseVoice tokens not found at {tokens_path}. "
                "Did scripts/download_models.py run at image build time?"
            )
        self._model_path = model_path
        self._language = language
        self._recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model_path),
            tokens=str(tokens_path),
            num_threads=config.num_threads,
            use_itn=config.use_itn,
            language=language,
            debug=False,
        )

    @property
    def model_path(self) -> Path:
        return self._model_path

    @property
    def language(self) -> str:
        return self._language

    def transcribe(self, audio: np.ndarray) -> TranscriptResult:
        """Decode a single finalized utterance into text.

        ``audio`` must be a 1-D float32 array of PCM samples at 16 kHz.
        The recognizer runs synchronously — this blocks the calling
        thread until inference completes (typically 200-800 ms on RPi5).
        """
        if audio.ndim != 1:
            raise ValueError(f"audio must be 1-D, got shape {audio.shape}")
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        audio_seconds = audio.size / SAMPLE_RATE

        t0 = time.monotonic()
        stream = self._recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self._recognizer.decode_stream(stream)
        decode_ms = (time.monotonic() - t0) * 1000.0

        result = stream.result
        return TranscriptResult(
            text=(getattr(result, "text", "") or "").strip(),
            emotion=getattr(result, "emotion", "") or "",
            event=getattr(result, "event", "") or "",
            decode_ms=decode_ms,
            audio_seconds=audio_seconds,
        )
