"""SenseVoice-Small STT via sherpa-onnx.

Single recognizer in auto-detect mode. Returns text + timing plus the
SenseVoice acoustic classifier outputs: ``emotion`` (NEUTRAL / HAPPY /
ANGRY / etc.) and ``event`` (Speech / Laughter / BGM / Applause / ...).
Language detection is NOT tracked or exposed — the gateway is expected
to handle language-related interpretation downstream via its LLM system
prompt.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import sherpa_onnx

SAMPLE_RATE = 16_000
MODEL_FILENAME = "model.int8.onnx"
TOKENS_FILENAME = "tokens.txt"


@dataclass
class TranscriptResult:
    """Outcome of a single SenseVoice decode."""

    text: str
    emotion: str  # e.g. "<|NEUTRAL|>", "<|HAPPY|>" — tag-wrapped, may be empty
    event: str   # e.g. "<|Speech|>", "<|Laughter|>" — tag-wrapped, may be empty
    decode_ms: float
    audio_seconds: float


class SenseVoice:
    """Wraps a single sherpa-onnx OfflineRecognizer for SenseVoice-Small."""

    def __init__(
        self,
        model_dir: Path,
        *,
        num_threads: int = 4,
        use_itn: bool = True,
    ) -> None:
        model_path = model_dir / MODEL_FILENAME
        tokens_path = model_dir / TOKENS_FILENAME
        if not model_path.is_file():
            raise FileNotFoundError(
                f"SenseVoice model not found at {model_path}. "
                "Did scripts/download_model.py run at image build time?"
            )
        if not tokens_path.is_file():
            raise FileNotFoundError(
                f"SenseVoice tokens not found at {tokens_path}. "
                "Did scripts/download_model.py run at image build time?"
            )
        self._model_path = model_path
        self._recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model_path),
            tokens=str(tokens_path),
            num_threads=num_threads,
            use_itn=use_itn,
            language="auto",
            debug=False,
        )

    @property
    def model_path(self) -> Path:
        return self._model_path

    def transcribe(self, audio: np.ndarray) -> TranscriptResult:
        """Decode a single finalized utterance into text."""
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
