"""Config-contract test: the whisper: section parses into WhisperConfig."""
from __future__ import annotations

from pathlib import Path

from whisper_stt.config import load_config


def test_whisper_section_parses(tmp_path: Path) -> None:
    cfg_text = """
schema_version: "0.1.0"
server: {host: "0.0.0.0", port: 8768, max_frame_bytes: 16777216}
vad:
  threshold: 0.5
  min_silence_ms: 200
  speech_pad_ms: 100
  pre_speech_chunks: 3
  silent_timeout_ms: 4000
  max_turn_duration_ms: 30000
  min_speech_duration_ms: 200
smart_turn: {decision_threshold: 0.5, intra_op_threads: 4}
whisper:
  model: "mlx-community/whisper-large-v3-turbo-8bit"
  language: "auto"
  no_speech_threshold: 0.6
  logprob_threshold: -1.0
  compression_ratio_threshold: 2.4
  initial_prompt: ""
  min_pause_ms: 2000
  rms_energy_floor: 0.005
  hallucination_phrases: ["thank you", "bye"]
  hallucination_max_duration_ms: 1500
  phrase_energy_multiplier: 2.0
recordings: {enabled: false}
logging: {level: "info", metrics_interval_ms: 1000, retention_days: 7}
"""
    p = tmp_path / "config.yaml"
    p.write_text(cfg_text)
    cfg = load_config(p, model_dir=tmp_path, log_dir=tmp_path, recording_dir=tmp_path)
    assert cfg.whisper.model == "mlx-community/whisper-large-v3-turbo-8bit"
    assert cfg.whisper.language == "auto"
    assert cfg.whisper.no_speech_threshold == 0.6
    assert cfg.whisper.compression_ratio_threshold == 2.4
    assert cfg.whisper.min_pause_ms == 2000
    assert cfg.whisper.rms_energy_floor == 0.005
    assert cfg.whisper.hallucination_phrases == ("thank you", "bye")
    assert cfg.whisper.hallucination_max_duration_ms == 1500
    assert cfg.whisper.phrase_energy_multiplier == 2.0
