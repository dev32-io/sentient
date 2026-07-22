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


def test_text_frontend_section_parsed(tmp_path):
    cfg = load_config(_EXAMPLE_PATH)
    assert cfg.text_frontend.enabled is True
    assert cfg.text_frontend.normalize is True


def test_missing_text_frontend_raises(tmp_path):
    """``text_frontend`` is a required section — dropping it from an
    otherwise-valid config must fail loud, not silently disable the frontend.
    """
    raw = yaml.safe_load(Path(_EXAMPLE_PATH).read_text(encoding="utf-8"))
    del raw["text_frontend"]
    p = tmp_path / "no_text_frontend.yaml"
    p.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="text_frontend"):
        load_config(str(p))


def test_text_frontend_speech_policy_keys_parsed(tmp_path):
    cfg = load_config(_EXAMPLE_PATH)
    assert cfg.text_frontend.table_max_cells == 24
    assert cfg.text_frontend.code_span_max_chars == 32
    assert cfg.text_frontend.speak_dropped_spans is True


def test_missing_table_max_cells_raises(tmp_path):
    """``table_max_cells`` is a required key — dropping it from an
    otherwise-valid config must fail loud, not silently fall back.
    """
    raw = yaml.safe_load(Path(_EXAMPLE_PATH).read_text(encoding="utf-8"))
    del raw["text_frontend"]["table_max_cells"]
    p = tmp_path / "no_table_max_cells.yaml"
    p.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="table_max_cells"):
        load_config(str(p))


def test_normalize_languages_parsed(tmp_path):
    cfg = load_config(_EXAMPLE_PATH)
    assert cfg.text_frontend.normalize_languages == ("zh", "ja")


def test_missing_normalize_languages_raises(tmp_path):
    """``normalize_languages`` is a required key — dropping it from an
    otherwise-valid config must fail loud, not silently normalize nothing
    (or everything).
    """
    raw = yaml.safe_load(Path(_EXAMPLE_PATH).read_text(encoding="utf-8"))
    del raw["text_frontend"]["normalize_languages"]
    p = tmp_path / "no_normalize_languages.yaml"
    p.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="normalize_languages"):
        load_config(str(p))


def test_unknown_normalize_language_raises(tmp_path):
    raw = yaml.safe_load(Path(_EXAMPLE_PATH).read_text(encoding="utf-8"))
    raw["text_frontend"]["normalize_languages"] = ["klingon"]
    p = tmp_path / "normalize_languages_unknown.yaml"
    p.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="normalize_languages"):
        load_config(str(p))


def test_cjk_ratio_parsed(tmp_path):
    cfg = load_config(_EXAMPLE_PATH)
    assert cfg.text_frontend.cjk_ratio == 0.2


def test_missing_cjk_ratio_raises(tmp_path):
    """``cjk_ratio`` is a required key — dropping it must fail loud, not
    silently fall back to "any CJK char present" (Finding 2's regression).
    """
    raw = yaml.safe_load(Path(_EXAMPLE_PATH).read_text(encoding="utf-8"))
    del raw["text_frontend"]["cjk_ratio"]
    p = tmp_path / "no_cjk_ratio.yaml"
    p.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="cjk_ratio"):
        load_config(str(p))


def test_invalid_default_lang_raises(tmp_path):
    """``default_lang`` selects the normalization engine (Finding 6) --
    an unrecognized tag like "en-US" must fail loud at load time rather
    than silently falling through ``resolve_lang`` to detection on every
    call.
    """
    raw = yaml.safe_load(Path(_EXAMPLE_PATH).read_text(encoding="utf-8"))
    raw["default_lang"] = "en-US"
    p = tmp_path / "bad_default_lang.yaml"
    p.write_text(yaml.safe_dump(raw), encoding="utf-8")
    with pytest.raises(ConfigError, match="default_lang"):
        load_config(str(p))
