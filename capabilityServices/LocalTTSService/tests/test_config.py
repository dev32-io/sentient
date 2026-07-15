"""Unit tests for the local-tts config loader.

Fail-loud contract: every key in ``config.example.yaml`` is required.
Mirrors ``WhisperSTTService/tests/test_config.py`` in spirit — this is a
plain unit test, no ``@live`` marker, no network/model access.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from local_tts.config import ConfigError, load_config

_EXAMPLE_PATH = "config/config.example.yaml"


def test_loads_example_config(tmp_path):
    cfg = load_config(_EXAMPLE_PATH)
    assert "Qwen3-TTS" in cfg.model
    assert cfg.server.port == 8770
    assert cfg.health.port == 8771
    assert cfg.default_format == "opus"
    assert cfg.default_sample_rate == 48000
    assert cfg.default_lang == "auto"
    assert not hasattr(cfg, "exaggeration")
    assert not hasattr(cfg, "cfg_weight")


def test_missing_key_fails_loud(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("schema_version: 1\n")
    with pytest.raises(Exception):
        load_config(str(p))


def test_missing_default_lang_fails_loud(tmp_path):
    """``default_lang`` is required, no silent default — dropping it from an
    otherwise-valid config must fail loud, not fall back to ``"auto"``.
    """
    raw = yaml.safe_load(Path(_EXAMPLE_PATH).read_text(encoding="utf-8"))
    del raw["default_lang"]
    p = tmp_path / "no_default_lang.yaml"
    p.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="default_lang"):
        load_config(str(p))
