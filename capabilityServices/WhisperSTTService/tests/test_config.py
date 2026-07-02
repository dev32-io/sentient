"""Unit tests for logging.retention_days config parsing.

Existing config fields are exercised at integration boot; here we only
cover the new validation surface.
"""

from __future__ import annotations

import tempfile
import textwrap
import unittest
from pathlib import Path

from whisper_stt.config import ConfigError, load_config


class _Omit:
    """Sentinel meaning "don't write a retention_days line at all"."""


_OMIT = _Omit()


def _write_yaml(dir_path: Path, retention_value: object) -> Path:
    """Materialize a complete config.yaml with the provided retention_days value."""
    if isinstance(retention_value, _Omit):
        retention_line = ""
    else:
        retention_line = f"  retention_days: {retention_value}\n"

    body = textwrap.dedent(
        """\
        server:
          host: "0.0.0.0"
          port: 8766
          max_frame_bytes: 16777216
        vad:
          threshold: 0.5
          min_silence_ms: 200
          speech_pad_ms: 30
          pre_speech_chunks: 10
          silent_timeout_ms: 2000
          max_turn_duration_ms: 600000
        smart_turn:
          decision_threshold: 0.5
          intra_op_threads: 4
        whisper:
          model: "mlx-community/whisper-large-v3-turbo-8bit"
          language: "auto"
          no_speech_threshold: 0.6
          logprob_threshold: -1.0
          compression_ratio_threshold: 2.4
          initial_prompt: ""
          min_pause_ms: 2000
          rms_energy_floor: 0.005
          hallucination_phrases: []
          hallucination_max_duration_ms: 1500
          phrase_energy_multiplier: 2.0
        recordings:
          enabled: false
        logging:
          level: "info"
          metrics_interval_ms: 1000
        """
    )
    body += retention_line
    path = dir_path / "config.yaml"
    path.write_text(body)
    return path


class LoggingRetentionParseTests(unittest.TestCase):
    """logging.retention_days field parsing and validation."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _load(self, path: Path):
        return load_config(
            path,
            model_dir=self.dir,
            log_dir=self.dir,
            recording_dir=self.dir,
        )

    def test_default_is_seven_when_omitted(self) -> None:
        path = _write_yaml(self.dir, _OMIT)
        cfg = self._load(path)
        self.assertEqual(cfg.logging.retention_days, 7)

    def test_accepts_explicit_value(self) -> None:
        path = _write_yaml(self.dir, 14)
        cfg = self._load(path)
        self.assertEqual(cfg.logging.retention_days, 14)

    def test_accepts_zero_as_disable(self) -> None:
        path = _write_yaml(self.dir, 0)
        cfg = self._load(path)
        self.assertEqual(cfg.logging.retention_days, 0)

    def test_accepts_max_boundary(self) -> None:
        path = _write_yaml(self.dir, 365)
        cfg = self._load(path)
        self.assertEqual(cfg.logging.retention_days, 365)

    def test_rejects_negative(self) -> None:
        path = _write_yaml(self.dir, -1)
        with self.assertRaises(ConfigError) as ctx:
            self._load(path)
        self.assertIn("retention_days", str(ctx.exception))

    def test_rejects_above_max(self) -> None:
        path = _write_yaml(self.dir, 366)
        with self.assertRaises(ConfigError) as ctx:
            self._load(path)
        self.assertIn("retention_days", str(ctx.exception))

    def test_rejects_non_integer(self) -> None:
        path = _write_yaml(self.dir, 7.5)
        with self.assertRaises(ConfigError) as ctx:
            self._load(path)
        self.assertIn("retention_days", str(ctx.exception))

    def test_rejects_boolean(self) -> None:
        # In Python, bool is a subclass of int. Make sure True/False
        # don't slip through as valid retention values.
        path = _write_yaml(self.dir, "true")
        with self.assertRaises(ConfigError) as ctx:
            self._load(path)
        self.assertIn("retention_days", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
