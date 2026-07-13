"""Per-``voiceId`` voice-pack store for Chatterbox TTS.

A "voice pack" is a persisted Chatterbox ``Conditionals`` object (T3 +
S3Gen conditioning derived from a reference clip) plus a small metadata
record. Packs live one-per-directory under ``voice_dir``::

    <voice_dir>/<voiceId>/conds.safetensors   # Conditionals.save()/.load()
    <voice_dir>/<voiceId>/meta.json           # {name, createdAt, refDurationMs}

Despite the ``.safetensors`` name (kept for readability/consistency with
the model's own built-in-voice file), ``Conditionals.save``/``.load``
(``mlx_audio.tts.models.chatterbox_turbo.chatterbox_turbo.Conditionals``)
pickle the ``{t3, gen}`` pair rather than using the real safetensors
format — confirmed by reading the installed venv source. We use those
methods as-is; the filename is just a label.

``get(None)`` (or an unknown/deleted ``voiceId``) falls back to the
model's built-in default conditioning via
``ChatterboxEngine.default_conditionals()`` — callers never need to
special-case "no voice selected".
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
from mlx_audio.tts.models.chatterbox_turbo import Conditionals

if TYPE_CHECKING:
    from .chatterbox_mlx import ChatterboxEngine

log = logging.getLogger("chatterbox_tts.voice_store")

_CONDS_FILENAME = "conds.safetensors"
_META_FILENAME = "meta.json"
_TMP_SUFFIX = ".tmp"


class VoiceStore:
    """Create/list/get/delete voice packs under ``voice_dir``."""

    def __init__(self, model: "ChatterboxEngine", voice_dir: Path) -> None:
        self._model = model
        self._voice_dir = Path(voice_dir)
        self._cache: dict[str, Any] = {}  # voiceId -> loaded Conditionals

    def get(self, voice_id: str | None) -> Any:
        """Return conditioning for ``voice_id``, or the model's built-in default."""
        if voice_id is None:
            log.debug("voice_store.get default reason=voice_id_none")
            return self._model.default_conditionals()

        if voice_id in self._cache:
            log.debug("voice_store.get cache_hit voice_id=%s", voice_id)
            return self._cache[voice_id]

        conds_path = self._pack_dir(voice_id) / _CONDS_FILENAME
        if not conds_path.is_file():
            log.warning(
                "voice_store.get fallback=default reason=unknown_voice voice_id=%s",
                voice_id,
            )
            return self._model.default_conditionals()

        conds = Conditionals.load(conds_path)
        self._cache[voice_id] = conds
        log.info("voice_store.get loaded voice_id=%s path=%s", voice_id, conds_path)
        return conds

    def create(self, ref_wav: np.ndarray, sr: int, name: str) -> dict:
        """Build conditioning from ``ref_wav`` and persist a new voice pack."""
        voice_id = uuid.uuid4().hex
        pack_dir = self._pack_dir(voice_id)
        pack_dir.mkdir(parents=True, exist_ok=True)
        log.info(
            "voice_store.create start voice_id=%s name=%s samples=%d sr=%d",
            voice_id, name, ref_wav.size, sr,
        )

        # Mutates the shared lru_cache'd model singleton's `_conds` as a
        # side effect of ChatterboxEngine.prepare_conditionals() (see that
        # method's docstring in chatterbox_mlx.py) — not made thread-safe
        # here; the WS server task is expected to serialize calls.
        conds = self._model.prepare_conditionals(ref_wav, sr)
        self._save_atomic(pack_dir / _CONDS_FILENAME, conds)

        created_at = time.time()
        ref_duration_ms = round((ref_wav.size / sr) * 1000.0) if sr > 0 else 0
        meta = {"name": name, "createdAt": created_at, "refDurationMs": ref_duration_ms}
        self._write_meta_atomic(pack_dir / _META_FILENAME, meta)

        self._cache[voice_id] = conds
        log.info(
            "voice_store.create done voice_id=%s ref_duration_ms=%d",
            voice_id, ref_duration_ms,
        )
        return {"voiceId": voice_id, "name": name, "createdAt": created_at}

    def list(self) -> list[dict]:
        """Return metadata (incl. ``voiceId``) for every persisted voice pack."""
        if not self._voice_dir.is_dir():
            return []
        packs: list[dict] = []
        for entry in sorted(self._voice_dir.iterdir()):
            if not entry.is_dir():
                continue
            pack = self._read_pack_meta(entry)
            if pack is not None:
                packs.append(pack)
        log.debug("voice_store.list count=%d", len(packs))
        return packs

    def delete(self, voice_id: str) -> bool:
        """Remove a voice pack. Returns ``False`` if it didn't exist."""
        pack_dir = self._pack_dir(voice_id)
        if not pack_dir.is_dir():
            log.debug("voice_store.delete missing voice_id=%s", voice_id)
            return False
        shutil.rmtree(pack_dir)
        self._cache.pop(voice_id, None)
        log.info("voice_store.delete done voice_id=%s", voice_id)
        return True

    def _pack_dir(self, voice_id: str) -> Path:
        return self._voice_dir / voice_id

    def _read_pack_meta(self, entry: Path) -> dict | None:
        """Load one pack's ``meta.json``, tagged with its ``voiceId``; ``None`` if unreadable."""
        meta_path = entry / _META_FILENAME
        if not meta_path.is_file():
            return None
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning(
                "voice_store.list bad_meta voice_id=%s error=%s", entry.name, exc
            )
            return None
        return {"voiceId": entry.name, **meta}

    @staticmethod
    def _save_atomic(path: Path, conds: Any) -> None:
        """Write ``conds`` via ``Conditionals.save`` to a temp file, then atomically rename."""
        tmp_path = Path(f"{path}{_TMP_SUFFIX}")
        conds.save(tmp_path)
        os.replace(tmp_path, path)

    @staticmethod
    def _write_meta_atomic(path: Path, meta: dict) -> None:
        """Write ``meta`` as JSON to a temp file, then atomically rename."""
        tmp_path = Path(f"{path}{_TMP_SUFFIX}")
        tmp_path.write_text(json.dumps(meta), encoding="utf-8")
        os.replace(tmp_path, path)
