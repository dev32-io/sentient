"""Smart-Turn v3 (ONNX) end-of-turn classifier.

This is a minimal, vendored adaptation of pipecat-ai/smart-turn's
reference inference logic. Contract:

    input:  np.float32 mono PCM samples at 16 kHz, in [-1, 1]
    output: SmartTurnResult(prediction, probability, eval_ms)

The model is Whisper-Tiny encoder + binary classifier. It consumes up
to the last 8 seconds of audio; longer inputs are truncated from the
end. Input is zero-padded to exactly 8 s by the feature extractor.

A single ``SmartTurn`` instance is shared across connections —
onnxruntime's ``InferenceSession`` is thread-safe for concurrent
``run()`` calls with distinct inputs, and holds model weights in
read-only memory.

Python note — ``@dataclass`` as return type:
  ``SmartTurnResult`` is a data container for inference output. Using a
  dataclass instead of a raw tuple means callers write
  ``result.probability`` instead of ``result[1]``. Same idea as a
  Kotlin ``data class`` — you get ``__init__``, ``__repr__``, ``__eq__``
  for free.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from transformers import WhisperFeatureExtractor

from .config import SmartTurnConfig

# Protocol constants — these are model architecture limits, NOT tunables.
# Changing them would require a different trained model.
SAMPLE_RATE = 16_000
MAX_SECONDS = 8
MAX_SAMPLES = SAMPLE_RATE * MAX_SECONDS

MODEL_FILENAME = "smart-turn-v3.2-cpu.onnx"


@dataclass
class SmartTurnResult:
    """Outcome of a single Smart-Turn evaluation."""

    prediction: int  # 1 = user turn is complete, 0 = still mid-turn
    probability: float  # raw sigmoid probability of "turn complete"
    eval_ms: float  # wall time (inference only)
    audio_seconds: float  # length of audio actually fed to the model


class SmartTurn:
    """Wraps the Smart-Turn v3 ONNX session and Whisper feature extractor.

    Python note — constructor with ``*`` keyword-only separator:
      After the ``*`` in ``__init__``, every argument MUST be passed by
      name: ``SmartTurn(model_dir, config=cfg)``. This prevents
      accidentally swapping positional arguments — a common source of
      bugs when multiple Path arguments are involved. Kotlin doesn't
      have this syntax, but the same intent is expressed with named
      arguments at the call site.
    """

    def __init__(self, model_dir: Path, *, config: SmartTurnConfig) -> None:
        model_path = model_dir / MODEL_FILENAME
        if not model_path.is_file():
            raise FileNotFoundError(
                f"Smart-Turn weights not found at {model_path}. "
                "Did scripts/download_models.py run at image build time?"
            )

        # WhisperFeatureExtractor is a stateless numpy transform; safe
        # to share across threads.
        self._feature_extractor = WhisperFeatureExtractor(
            chunk_length=MAX_SECONDS,
        )
        self._decision_threshold = config.decision_threshold

        so = ort.SessionOptions()
        so.intra_op_num_threads = config.intra_op_threads
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session = ort.InferenceSession(
            str(model_path),
            sess_options=so,
            providers=["CPUExecutionProvider"],
        )
        self._model_path = model_path

    @property
    def model_path(self) -> Path:
        return self._model_path

    def predict(self, audio: np.ndarray) -> SmartTurnResult:
        """Classify whether ``audio`` ends on a completed user turn.

        ``audio`` must be float32 mono PCM at 16 kHz. If longer than
        8 s, only the final 8 s are used.
        """
        if audio.ndim != 1:
            raise ValueError(f"audio must be 1-D, got shape {audio.shape}")
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32, copy=False)

        if audio.size > MAX_SAMPLES:
            audio = audio[-MAX_SAMPLES:]

        audio_seconds = audio.size / SAMPLE_RATE

        inputs = self._feature_extractor(
            audio,
            sampling_rate=SAMPLE_RATE,
            return_tensors="np",
            padding="max_length",
            max_length=MAX_SAMPLES,
            truncation=True,
            do_normalize=True,
        )
        feats = np.expand_dims(
            inputs.input_features.squeeze(0).astype(np.float32),
            axis=0,
        )

        t0 = time.monotonic()
        outputs = self._session.run(None, {"input_features": feats})
        eval_ms = (time.monotonic() - t0) * 1000.0

        probability = float(outputs[0][0].item())
        prediction = 1 if probability > self._decision_threshold else 0

        return SmartTurnResult(
            prediction=prediction,
            probability=probability,
            eval_ms=eval_ms,
            audio_seconds=audio_seconds,
        )
