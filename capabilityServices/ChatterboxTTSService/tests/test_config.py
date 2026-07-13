"""Unit tests for the Chatterbox-TTS config loader.

Fail-loud contract: every key in ``config.example.yaml`` is required.
Mirrors ``WhisperSTTService/tests/test_config.py`` in spirit — this is a
plain unit test, no ``@live`` marker, no network/model access.
"""

from __future__ import annotations

import pytest

from chatterbox_tts.config import load_config


def test_loads_example_config(tmp_path):
    cfg = load_config("config/config.example.yaml")
    assert cfg.model == "mlx-community/Chatterbox-TTS-8bit" or "Chatterbox" in cfg.model
    assert cfg.server.port == 8770
    assert cfg.health.port == 8771
    assert cfg.default_format == "opus"
    assert cfg.default_sample_rate == 48000


def test_missing_key_fails_loud(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("schema_version: 1\n")
    with pytest.raises(Exception):
        load_config(str(p))
