"""Voice-pack store: create/list/get/delete.

Non-live tests exercise ``list()``/``delete(missing)``/``get(None)``/
``get(unknown)`` against a lightweight stub in place of
``ChatterboxEngine`` — no MLX model load, no network. The live roundtrip
(``create()`` -> real ``prepare_conditionals()`` -> ``get()``) is
``@pytest.mark.live`` and excluded from the default run (see
``pyproject.toml``'s ``addopts``), matching the sibling
``test_chatterbox_mlx.py`` pattern.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from chatterbox_tts.voice_store import VoiceStore

_SENTINEL_DEFAULT = object()


class _StubEngine:
    """Fake ``ChatterboxEngine``: only ``default_conditionals()`` — no MLX model."""

    def default_conditionals(self) -> object:
        return _SENTINEL_DEFAULT


def test_list_empty(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    assert store.list() == []


def test_delete_missing_returns_false(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    # Well-formed (32 hex chars) but never created — "not found", not "invalid".
    assert store.delete("a" * 32) is False


def test_get_default_when_none(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    assert store.get(None) is _SENTINEL_DEFAULT


def test_get_default_when_unknown_voice_id(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    # Well-formed (32 hex chars) but never created — "not found", not "invalid".
    assert store.get("b" * 32) is _SENTINEL_DEFAULT


@pytest.mark.parametrize(
    "bad_voice_id",
    [
        "../../etc/passwd",
        "..%2f..%2f",
        "/abs/path",
        "a" * 31,  # too short
        "g" * 32,  # right length, non-hex alphabet
    ],
)
def test_get_rejects_traversal_voice_id(tmp_path: Path, bad_voice_id: str) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    with pytest.raises(ValueError):
        store.get(bad_voice_id)


@pytest.mark.parametrize(
    "bad_voice_id",
    [
        "../../etc/passwd",
        "..%2f..%2f",
        "/abs/path",
        "a" * 31,  # too short
        "g" * 32,  # right length, non-hex alphabet
    ],
)
def test_delete_rejects_traversal(tmp_path: Path, bad_voice_id: str) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    with pytest.raises(ValueError):
        store.delete(bad_voice_id)


def test_get_accepts_well_formed_voice_id(tmp_path: Path) -> None:
    """A normal uuid4().hex id passes validation (falls back since it's unknown)."""
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    assert store.get("0123456789abcdef0123456789abcdef") is _SENTINEL_DEFAULT


def test_create_rejects_short_clip(tmp_path: Path) -> None:
    """A <=5s reference clip is rejected before any filesystem work."""
    voice_dir = tmp_path / "voices"
    store = VoiceStore(_StubEngine(), voice_dir)

    sr = 24_000
    short_clip = np.zeros(int(2 * sr), dtype=np.float32)  # 2s, well under the 5s floor

    with pytest.raises(ValueError):
        store.create(short_clip, sr, "Too Short")

    # No pack dir (not even voice_dir itself) should have been created.
    assert not voice_dir.exists() or list(voice_dir.iterdir()) == []


class _FailingPrepareEngine(_StubEngine):
    """Fake ``ChatterboxEngine`` whose ``prepare_conditionals`` always blows up."""

    def prepare_conditionals(self, ref_wav: np.ndarray, sr: int) -> object:
        raise RuntimeError("boom")


def test_create_cleans_up_on_failure(tmp_path: Path) -> None:
    """A failure mid-create leaves no orphaned ``<voice_dir>/<uuid>/`` behind."""
    voice_dir = tmp_path / "voices"
    store = VoiceStore(_FailingPrepareEngine(), voice_dir)

    sr = 24_000
    long_clip = np.zeros(int(6 * sr), dtype=np.float32)  # 6s, passes the length pre-check

    with pytest.raises(RuntimeError):
        store.create(long_clip, sr, "Ill-Fated Voice")

    # voice_dir itself is created in __init__, but no per-voice subdirectory
    # should survive the failed create().
    assert list(voice_dir.iterdir()) == []


@pytest.mark.live
def test_create_then_get_roundtrip(tmp_path: Path) -> None:
    """Live: needs the real model to build conditioning from a reference clip."""
    from chatterbox_tts.chatterbox_mlx import ChatterboxEngine

    model_id = "mlx-community/Chatterbox-Turbo-TTS-8bit"
    engine = ChatterboxEngine(model_id, 0.5, 0.5)
    voice_dir = tmp_path / "voices"
    store = VoiceStore(engine, voice_dir)

    # prepare_conditionals requires > 5s of reference audio at 24kHz.
    sr = 24_000
    duration_s = 6.0
    t = np.linspace(0, duration_s, int(sr * duration_s), endpoint=False)
    tone = (0.2 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)

    result = store.create(tone, sr, "Test Voice")
    voice_id = result["voiceId"]
    assert result["name"] == "Test Voice"
    assert "createdAt" in result

    pack_dir = voice_dir / voice_id
    assert (pack_dir / "conds.safetensors").is_file()
    assert (pack_dir / "meta.json").is_file()

    listed = store.list()
    assert any(p["voiceId"] == voice_id and p["name"] == "Test Voice" for p in listed)

    loaded = store.get(voice_id)
    assert loaded is not None

    # A fresh store (no in-memory cache) must load the same pack from disk.
    store2 = VoiceStore(engine, voice_dir)
    loaded2 = store2.get(voice_id)
    assert loaded2 is not None

    assert store.delete(voice_id) is True
    assert not pack_dir.exists()
