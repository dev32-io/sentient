"""Voice-pack store: create/list/get/delete.

Non-live tests exercise the store end-to-end against real (tiny) wav
files on disk — ``get()``/``create()`` never load or parse the ref clip
content, they just resolve/write a path, so no MLX model or network is
needed even to prove ``create() -> get()`` round-trips a pack. The one
test that genuinely needs the real model is the live roundtrip
(``create()`` -> ``get()`` -> ``QwenEngine.synthesize()`` with that ref
path), marked ``@pytest.mark.live`` and excluded from the default run
(see ``pyproject.toml``'s ``addopts``), matching the sibling
``test_qwen_engine.py`` pattern.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from chatterbox_tts.voice_store import VoiceStore

_SR = 24_000


class _StubEngine:
    """Fake engine placeholder — ``VoiceStore`` no longer calls anything on
    it (Qwen3-TTS clones from the persisted ref wav path at synth time,
    not via an engine-side "prepare" step). Kept only because the
    constructor still accepts a ``model`` positional arg."""


def test_list_empty(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    assert store.list() == []


def test_delete_missing_returns_false(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    # Well-formed (32 hex chars) but never created — "not found", not "invalid".
    assert store.delete("a" * 32) is False


def test_get_default_when_none(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    assert store.get(None) is None


def test_get_default_when_unknown_voice_id(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    # Well-formed (32 hex chars) but never created — "not found", not "invalid".
    assert store.get("b" * 32) is None


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
    assert store.get("0123456789abcdef0123456789abcdef") is None


def test_create_rejects_short_clip(tmp_path: Path) -> None:
    """A <=3s reference clip is rejected before any filesystem work."""
    voice_dir = tmp_path / "voices"
    store = VoiceStore(_StubEngine(), voice_dir)

    short_clip = np.zeros(int(2 * _SR), dtype=np.float32)  # 2s, well under the 3s floor

    with pytest.raises(ValueError):
        store.create(short_clip, _SR, "Too Short")

    # No pack dir (not even voice_dir itself) should have been created.
    assert not voice_dir.exists() or list(voice_dir.iterdir()) == []


def test_create_cleans_up_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A failure mid-create leaves no orphaned ``<voice_dir>/<uuid>/`` behind."""
    voice_dir = tmp_path / "voices"
    store = VoiceStore(_StubEngine(), voice_dir)

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr("chatterbox_tts.voice_store.sf.write", _boom)

    long_clip = np.zeros(int(6 * _SR), dtype=np.float32)  # 6s, passes the length pre-check

    with pytest.raises(RuntimeError):
        store.create(long_clip, _SR, "Ill-Fated Voice")

    # voice_dir itself is created in __init__, but no per-voice subdirectory
    # should survive the failed create().
    assert list(voice_dir.iterdir()) == []


def test_create_writes_readable_ref_wav(tmp_path: Path) -> None:
    """``create()`` writes a real, readable wav — not just any bytes."""
    voice_dir = tmp_path / "voices"
    store = VoiceStore(_StubEngine(), voice_dir)

    duration_s = 4.0
    ref_wav = np.zeros(int(duration_s * _SR), dtype=np.float32)

    result = store.create(ref_wav, _SR, "Test Voice")
    voice_id = result["voiceId"]
    assert result["name"] == "Test Voice"
    assert "createdAt" in result

    ref_path = voice_dir / voice_id / "ref.wav"
    assert ref_path.is_file()

    data, read_sr = sf.read(ref_path)
    assert read_sr == _SR
    assert len(data) == ref_wav.size


def test_create_then_get_returns_ref_path(tmp_path: Path) -> None:
    """``get(voiceId)`` resolves to the persisted pack's ref.wav path."""
    voice_dir = tmp_path / "voices"
    store = VoiceStore(_StubEngine(), voice_dir)

    ref_wav = np.zeros(int(4.0 * _SR), dtype=np.float32)
    result = store.create(ref_wav, _SR, "Test Voice")
    voice_id = result["voiceId"]

    assert store.get(voice_id) == str(voice_dir / voice_id / "ref.wav")


def test_list_returns_description_and_tags(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    pack = tmp_path / "voices" / ("a" * 32)
    pack.mkdir(parents=True)
    (pack / "ref.wav").write_bytes(b"stub")
    (pack / "meta.json").write_text(
        json.dumps({"name": "Nova", "description": "Warm", "tags": ["warm"], "createdAt": 1.0, "refDurationMs": 6000})
    )
    [entry] = store.list()
    assert entry["description"] == "Warm"
    assert entry["tags"] == ["warm"]


def test_list_defaults_missing_description_and_tags(tmp_path: Path) -> None:
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    pack = tmp_path / "voices" / ("a" * 32)
    pack.mkdir(parents=True)
    (pack / "ref.wav").write_bytes(b"stub")
    (pack / "meta.json").write_text(json.dumps({"name": "Old", "createdAt": 1.0, "refDurationMs": 6000}))
    [entry] = store.list()
    assert entry["description"] == ""
    assert entry["tags"] == []


def _write_builtin(builtin_dir: Path, slug: str, name: str, tags: list[str]) -> None:
    pack = builtin_dir / slug
    pack.mkdir(parents=True)
    (pack / "ref.wav").write_bytes(b"stub")
    (pack / "meta.json").write_text(json.dumps({"name": name, "description": "", "tags": tags}))


def test_list_merges_builtins_first_with_source(tmp_path: Path) -> None:
    builtin = tmp_path / "library"
    _write_builtin(builtin, "nova", "Nova", ["warm"])
    store = VoiceStore(_StubEngine(), tmp_path / "voices", builtin_dir=builtin)
    packs = store.list()
    assert packs[0]["voiceId"] == "nova"
    assert packs[0]["source"] == "builtin"


def test_delete_builtin_refused(tmp_path: Path) -> None:
    builtin = tmp_path / "library"
    _write_builtin(builtin, "nova", "Nova", [])
    store = VoiceStore(_StubEngine(), tmp_path / "voices", builtin_dir=builtin)
    with pytest.raises(ValueError, match="builtin-voice"):
        store.delete("nova")


def test_get_resolves_builtin_slug(tmp_path: Path) -> None:
    """``get()`` only resolves a path (never parses ref.wav), so this is
    safe to exercise directly — no stub bytes vs. real-wav distinction
    matters here."""
    builtin = tmp_path / "library"
    _write_builtin(builtin, "nova", "Nova", [])
    store = VoiceStore(_StubEngine(), tmp_path / "voices", builtin_dir=builtin)
    assert store.get("nova") == str(builtin / "nova" / "ref.wav")


@pytest.mark.live
def test_create_then_get_roundtrip(tmp_path: Path) -> None:
    """Live: persist a real ref.wav pack, then synthesize with the real
    QwenEngine using the persisted path (real speaker-encoder cloning)."""
    import threading

    from chatterbox_tts.qwen_engine import QwenEngine

    model_id = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"
    engine = QwenEngine(model_id)
    voice_dir = tmp_path / "voices"
    store = VoiceStore(engine, voice_dir)

    # Reuse the same bench reference clip as test_qwen_engine.py (~5.5s,
    # well over the 3s floor).
    ref_source = Path(__file__).resolve().parents[3] / "pocs" / "localTTS" / "ref.wav"
    ref_wav, sr = sf.read(ref_source, dtype="float32")

    result = store.create(ref_wav, sr, "Test Voice")
    voice_id = result["voiceId"]
    assert result["name"] == "Test Voice"
    assert "createdAt" in result

    pack_dir = voice_dir / voice_id
    assert (pack_dir / "ref.wav").is_file()
    assert (pack_dir / "meta.json").is_file()

    listed = store.list()
    assert any(p["voiceId"] == voice_id and p["name"] == "Test Voice" for p in listed)

    ref_path = store.get(voice_id)
    assert ref_path == str(pack_dir / "ref.wav")

    # Exercise the real qwen synth path with the persisted ref wav.
    chunks = list(
        engine.synthesize("Hello there, this is a cloning test.", ref_path, "auto", 2.0, threading.Event())
    )
    assert len(chunks) >= 1
    assert sum(c.size for c in chunks) > 0

    # A fresh store (no in-memory state) resolves the same pack from disk.
    store2 = VoiceStore(engine, voice_dir)
    assert store2.get(voice_id) == ref_path

    assert store.delete(voice_id) is True
    assert not pack_dir.exists()
