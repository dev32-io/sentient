"""Manual turn-mode contract for TurnPipeline (hold-to-talk).

Pins the ``semantic_turns`` gate the STT service exposes via the
``turn_mode`` control message (see CONTRACT.md §4.2):

- default is semantic (today's behavior, byte-for-byte);
- semantic mode still runs Smart-Turn and finalizes on ``vad_end``;
- manual mode NEVER invokes Smart-Turn — no ``smart_turn_eval`` events,
  no VAD-silence finalization — yet still emits ``vad_start`` / ``vad_end``;
- a manual turn finalizes only via ``flush`` (client release) or the
  ``max_turn_duration`` safety valve;
- a mode flip with an OPEN turn force-finalizes first
  (``reason="mode_change"``, WARN) then switches;
- flipping to the mode already in effect is a no-op.

Heavy models (Silero JIT, Smart-Turn ONNX, MLX Whisper) are never loaded:
``get_silero_model`` and ``VADIterator`` are stubbed so the VAD stream is
scripted, and Smart-Turn / STT are injected fakes. This mirrors the
existing tests' "no model download in a unit test" discipline.
"""
from __future__ import annotations

import logging

import numpy as np

from whisper_stt import turn_pipeline as tp
from whisper_stt.config import (
    Config,
    LoggingConfig,
    RecordingsConfig,
    ServerConfig,
    SmartTurnConfig,
    VadConfig,
    WhisperConfig,
)
from whisper_stt.pipeline_events import (
    SmartTurnEval,
    TranscriptReady,
    TurnComplete,
    VadEnd,
    VadStart,
)
from whisper_stt.smart_turn import SmartTurnResult
from whisper_stt.turn_pipeline import TurnPipeline
from whisper_stt.whisper_mlx import TranscriptResult

# One non-silent 512-sample Silero chunk (1024 bytes PCM16 LE). Amplitude
# is well above any energy floor so decode_turn keeps the super-segment.
_CHUNK = np.full(tp.SILERO_CHUNK_SAMPLES, 1200, dtype="<i2").tobytes()


# --------------------------------------------------------------------------
# Fakes / stubs — no ML models, deterministic VAD script.
# --------------------------------------------------------------------------


class _ScriptVad:
    """Deterministic stand-in for silero ``VADIterator``.

    One ``__call__`` per 512-sample chunk; returns the next scripted item
    (``None`` | ``{"start": n}`` | ``{"end": n}``). Accepts the real
    constructor args and ignores them.
    """

    def __init__(self, *_args, **_kwargs) -> None:
        self._script: list[object] = []
        self._i = 0
        self.reset_calls = 0

    def script(self, items: list[object]) -> None:
        self._script = list(items)
        self._i = 0

    def __call__(self, _tensor) -> object:
        val = self._script[self._i] if self._i < len(self._script) else None
        self._i += 1
        return val

    def reset_states(self) -> None:
        self.reset_calls += 1


class _SpySmartTurn:
    """Records every ``predict`` call so tests can assert it is (or isn't) hit."""

    def __init__(self, *, prediction: int = 1, probability: float = 0.9) -> None:
        self.calls = 0
        self._prediction = prediction
        self._probability = probability

    def predict(self, audio: np.ndarray) -> SmartTurnResult:
        self.calls += 1
        return SmartTurnResult(
            prediction=self._prediction,
            probability=self._probability,
            eval_ms=1.0,
            audio_seconds=float(audio.size) / 16000,
        )


class _FakeStt:
    """Returns canned transcripts in call order (mirrors test_turn_decoder)."""

    def __init__(self, texts: list[str]) -> None:
        self._texts = list(texts)
        self._i = 0

    def transcribe(self, audio: np.ndarray) -> TranscriptResult:
        text = self._texts[self._i % len(self._texts)] if self._texts else ""
        self._i += 1
        return TranscriptResult(
            text=text,
            emotion="",
            event="",
            decode_ms=1.0,
            audio_seconds=float(audio.size) / 16000,
            no_speech_prob=0.1,
            avg_logprob=-0.2,
        )


class _RecordingLogger:
    """Captures ``.log(event, **fields)`` calls for assertion."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def log(self, event: str, **fields) -> None:
        self.events.append((event, fields))


def _make_config(
    tmp_path,
    *,
    max_turn_duration_ms: int = 600_000,
    min_speech_duration_ms: int = 0,
) -> Config:
    """Minimal in-memory Config — gates open so a real transcript survives.

    ``rms_energy_floor=0.0`` and empty hallucination/backchannel lists keep
    decode_turn from dropping the (synthetic) audio; ``min_speech_duration_ms=0``
    disables the Step-0 duration gate so short scripted turns still finalize.
    """
    return Config(
        server=ServerConfig(host="0.0.0.0", port=8766, max_frame_bytes=16_777_216),
        vad=VadConfig(
            threshold=0.5,
            min_silence_ms=200,
            speech_pad_ms=30,
            pre_speech_chunks=10,
            silent_timeout_ms=2000,
            max_turn_duration_ms=max_turn_duration_ms,
            min_speech_duration_ms=min_speech_duration_ms,
        ),
        smart_turn=SmartTurnConfig(decision_threshold=0.5, intra_op_threads=1),
        whisper=WhisperConfig(
            model="stub",
            language="auto",
            language_min_confidence=0.5,
            encode_buckets_s=(5, 10, 20, 30),
            no_speech_threshold=0.6,
            logprob_threshold=-1.0,
            compression_ratio_threshold=2.4,
            initial_prompt="",
            min_pause_ms=2000,
            rms_energy_floor=0.0,
            hallucination_phrases=(),
            hallucination_max_duration_ms=1500,
            phrase_energy_multiplier=2.0,
            backchannel_phrases=(),
        ),
        recordings=RecordingsConfig(enabled=False),
        logging=LoggingConfig(level="info", metrics_interval_ms=1000, retention_days=7),
        model_dir=tmp_path,
        log_dir=tmp_path,
        recording_dir=tmp_path,
    )


def _make_pipeline(monkeypatch, tmp_path, *, smart_turn, stt, logger, **cfg_kwargs):
    """Build a TurnPipeline with a scripted VAD and no model loads."""
    monkeypatch.setattr(tp, "get_silero_model", lambda: object())
    monkeypatch.setattr(tp, "VADIterator", _ScriptVad)
    cfg = _make_config(tmp_path, **cfg_kwargs)
    return TurnPipeline(
        "conn-test",
        config=cfg,
        smart_turn=smart_turn,
        stt=stt,
        recording_dir=tmp_path,
        logger=logger,
    )


def _feed(pipe: TurnPipeline, n: int) -> list:
    """Feed ``n`` single-chunk process() calls; return concatenated events."""
    events: list = []
    for _ in range(n):
        events.extend(pipe.process(_CHUNK))
    return events


# --------------------------------------------------------------------------
# Default + semantic mode (unchanged behavior)
# --------------------------------------------------------------------------


def test_default_mode_is_semantic(monkeypatch, tmp_path) -> None:
    pipe = _make_pipeline(
        monkeypatch, tmp_path,
        smart_turn=_SpySmartTurn(), stt=_FakeStt(["x"]), logger=_RecordingLogger(),
    )
    assert pipe._semantic_turns is True


def test_semantic_mode_finalizes_via_smart_turn(monkeypatch, tmp_path) -> None:
    spy = _SpySmartTurn(prediction=1)
    pipe = _make_pipeline(
        monkeypatch, tmp_path,
        smart_turn=spy, stt=_FakeStt(["hello world"]), logger=_RecordingLogger(),
    )
    pipe._vad_iter.script([{"start": 0}, None, None, {"end": 3}])
    events = _feed(pipe, 4)

    assert spy.calls == 1
    assert any(isinstance(e, SmartTurnEval) for e in events)
    assert any(isinstance(e, VadStart) for e in events)
    assert any(isinstance(e, VadEnd) for e in events)
    assert any(isinstance(e, TurnComplete) for e in events)
    assert any(isinstance(e, TranscriptReady) for e in events)


# --------------------------------------------------------------------------
# Manual mode — Smart-Turn bypassed
# --------------------------------------------------------------------------


def test_manual_mode_bypasses_smart_turn_on_vad_end(monkeypatch, tmp_path) -> None:
    spy = _SpySmartTurn(prediction=1)
    logger = _RecordingLogger()
    pipe = _make_pipeline(
        monkeypatch, tmp_path,
        smart_turn=spy, stt=_FakeStt(["hello world"]), logger=logger,
    )
    # Enter manual with no open turn -> silent switch (no events).
    assert pipe.set_turn_mode(False) == []

    pipe._vad_iter.script([{"start": 0}, None, {"end": 2}, None])
    events = _feed(pipe, 4)

    # Smart-Turn is never invoked and never surfaces an eval event.
    assert spy.calls == 0
    assert not any(isinstance(e, SmartTurnEval) for e in events)
    # vad_end does NOT finalize a manual turn.
    assert not any(isinstance(e, (TurnComplete, TranscriptReady)) for e in events)
    # VAD activity is still reported to the client.
    assert any(isinstance(e, VadStart) for e in events)
    assert any(isinstance(e, VadEnd) for e in events)
    # The bypass is traced.
    assert any(ev == "smart_turn.bypassed" for ev, _ in logger.events)
    # Turn stays open until the client releases.
    assert pipe._turn_active is True


def test_manual_mode_flush_finalizes(monkeypatch, tmp_path) -> None:
    spy = _SpySmartTurn()
    pipe = _make_pipeline(
        monkeypatch, tmp_path,
        smart_turn=spy, stt=_FakeStt(["turn it off"]), logger=_RecordingLogger(),
    )
    pipe.set_turn_mode(False)

    # Hold + speak, keep holding (no vad_end), then release -> flush.
    pipe._vad_iter.script([{"start": 0}, None, None, None])
    _feed(pipe, 4)
    assert spy.calls == 0

    events = pipe.flush()

    # flush finalizes without ever touching Smart-Turn.
    assert spy.calls == 0
    assert any(isinstance(e, TurnComplete) for e in events)
    transcript = next(e for e in events if isinstance(e, TranscriptReady))
    assert transcript.text == "turn it off"
    assert pipe._turn_active is False


def test_manual_mode_max_turn_duration_still_finalizes(monkeypatch, tmp_path) -> None:
    # Safety valve: with the guard armed (max_turn_duration_ms=0 => always
    # over budget), a manual turn still force-finalizes on the next chunk.
    spy = _SpySmartTurn()
    logger = _RecordingLogger()
    pipe = _make_pipeline(
        monkeypatch, tmp_path,
        smart_turn=spy, stt=_FakeStt(["hi there"]), logger=logger,
        max_turn_duration_ms=0,
    )
    pipe.set_turn_mode(False)

    pipe._vad_iter.script([{"start": 0}, None])
    events = _feed(pipe, 2)

    assert spy.calls == 0
    assert any(isinstance(e, TurnComplete) for e in events)
    reasons = [f["reason"] for ev, f in logger.events if ev == "turn.force_finalize"]
    assert reasons == ["max_turn_duration"]


# --------------------------------------------------------------------------
# Mode flip
# --------------------------------------------------------------------------


def test_mode_flip_with_open_turn_force_finalizes(monkeypatch, tmp_path, caplog) -> None:
    spy = _SpySmartTurn()
    logger = _RecordingLogger()
    pipe = _make_pipeline(
        monkeypatch, tmp_path,
        smart_turn=spy, stt=_FakeStt(["mid stream"]), logger=logger,
    )
    pipe.set_turn_mode(False)  # manual

    pipe._vad_iter.script([{"start": 0}, None, None])
    _feed(pipe, 3)
    assert pipe._turn_active is True

    with caplog.at_level(logging.WARNING, logger="stt-service"):
        events = pipe.set_turn_mode(True)  # flip back to semantic mid-turn

    # Force-finalized (synthetic, no Smart-Turn) before switching.
    assert spy.calls == 0
    assert any(isinstance(e, TurnComplete) for e in events)
    assert any(isinstance(e, TranscriptReady) for e in events)
    assert any(ev == "turn_mode.change_mid_turn" for ev, _ in logger.events)
    reasons = [f["reason"] for ev, f in logger.events if ev == "turn.force_finalize"]
    assert reasons == ["mode_change"]
    # A WARN was emitted on the service logger.
    assert any(rec.levelno == logging.WARNING for rec in caplog.records)
    # Mode switched and the turn is closed.
    assert pipe._semantic_turns is True
    assert pipe._turn_active is False


def test_set_turn_mode_noop_when_unchanged(monkeypatch, tmp_path) -> None:
    logger = _RecordingLogger()
    pipe = _make_pipeline(
        monkeypatch, tmp_path,
        smart_turn=_SpySmartTurn(), stt=_FakeStt(["x"]), logger=logger,
    )
    # Already semantic: re-asserting semantic is a no-op (no switch log).
    assert pipe.set_turn_mode(True) == []
    assert not any(ev == "turn_mode.set" for ev, _ in logger.events)

    pipe.set_turn_mode(False)
    logger.events.clear()
    # Already manual: re-asserting manual is a no-op (no force-finalize, no log).
    assert pipe.set_turn_mode(False) == []
    assert logger.events == []
