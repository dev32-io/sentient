"""Per-``voiceId`` voice-pack store for Qwen3-TTS speaker-encoder cloning.

A "voice pack" is a persisted raw reference clip (a mono float32 wav)
plus a small metadata record. Qwen3-TTS clones a voice directly from
that reference wav at synth time (its speaker encoder runs per-call) —
there is no precomputed conditioning object to build or cache here.
User-created packs live
one-per-directory under ``voice_dir``::

    <voice_dir>/<voiceId>/ref.wav    # mono float32, soundfile.write()/.read()
    <voice_dir>/<voiceId>/meta.json  # {name, description, tags, language, createdAt, refDurationMs}

(see ``pack_meta.py`` for the shared on-disk shape). A second, read-only
``builtin_dir`` holds packaged voice packs in the same shape, addressed
by a short slug (e.g. ``nova``) instead of a ``uuid4().hex`` — resolved
via the ``BuiltinLibrary`` collaborator (``builtin_library.py``), which
``VoiceStore`` composes and checks first in ``get``/``delete``/``list``.

``get(None)`` (or an unknown/deleted ``voiceId``) returns ``None`` — the
engine's own default-voice path, which the Qwen synth call handles by
passing ``ref_audio=None``. Callers never need to special-case "no voice
selected".

Security notes (``voiceId`` arrives from an external boundary: webui ->
gateway -> WS ``voice.delete``/``voice.select`` -> this store):

- **Path traversal.** Every caller-supplied ``voice_id`` (``get``,
  ``delete``) is checked against the ``BuiltinLibrary`` slug set (exact
  membership) or the ``uuid4().hex`` shape (``^[0-9a-f]{32}$``, the
  format ``create()`` generates) before it ever reaches a filesystem
  path, plus a belt-and-suspenders resolved-path check. ``create()``
  mints its own id, so it skips validation.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

from .builtin_library import BuiltinLibrary
from .pack_meta import META_FILENAME, REF_FILENAME, read_pack_meta

log = logging.getLogger("local_tts.voice_store")

_TMP_SUFFIX = ".tmp"
_DIR_MODE = 0o700  # service-user-only

# soundfile can't infer a format from a "ref.wav.tmp" extension (the
# atomic-write temp path), so the format is passed explicitly.
_REF_SF_FORMAT = "WAV"

# A practical floor for usable speaker-embedding extraction — short of a
# hard model-side assertion (Qwen3-TTS's speaker encoder has none), but
# clips at or under this length produce unreliable clones in bench
# testing. Reject before any filesystem work so the caller gets a typed
# ValueError instead of a bad-quality clone downstream.
_MIN_REF_SECONDS = 3.0

# uuid.uuid4().hex shape — exactly what create() generates. Anything else
# (path separators, "..", absolute paths, wrong length/alphabet) is rejected
# before it can reach a filesystem path; see _validate_voice_id.
_VOICE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class VoiceStore:
    """Create/list/get/delete voice packs under ``voice_dir``, plus a
    read-only ``builtin_dir`` merged in ahead of them (see module docstring)."""

    def __init__(self, model: Any, voice_dir: Path, builtin_dir: Path | None = None) -> None:
        # `model` is unused by create()/get() — Qwen3-TTS clones from the
        # raw ref wav at synth time, no engine-side "prepare" step. Kept
        # for constructor-signature compatibility with callers
        # (server.py/__main__.py); a later task drops this parameter.
        self._model = model
        self._voice_dir = Path(voice_dir)
        self._builtin = BuiltinLibrary(builtin_dir)

        os.makedirs(self._voice_dir, mode=_DIR_MODE, exist_ok=True)
        os.chmod(self._voice_dir, _DIR_MODE)

    def get(self, voice_id: str | None) -> str | None:
        """Return the ref.wav path for ``voice_id``, or ``None`` (engine default)."""
        if voice_id is None:
            log.debug("voice_store.get default reason=voice_id_none")
            return None

        if self._builtin.has(voice_id):
            return self._ref_path(voice_id, self._builtin.pack_dir(voice_id))

        # Validate untrusted input before it reaches any filesystem path —
        # see module docstring's "Path traversal" note.
        pack_dir = self._validated_pack_dir(voice_id)
        return self._ref_path(voice_id, pack_dir)

    def _ref_path(self, voice_id: str, pack_dir: Path) -> str | None:
        """Resolve a validated ``pack_dir`` to its ref.wav path, or ``None`` if missing."""
        ref_path = pack_dir / REF_FILENAME
        if not ref_path.is_file():
            log.warning(
                "voice_store.get fallback=default reason=unknown_voice voice_id=%s",
                voice_id,
            )
            return None
        log.info("voice_store.get resolved voice_id=%s path=%s", voice_id, ref_path)
        return str(ref_path)

    def get_or_default(self, voice_id: str | None) -> str | None:
        """Like ``get``, but never raises: a malformed ``voice_id`` (fails
        ``get``'s traversal/format validation) falls back to the default
        voice with a warning — same outcome as an unknown-but-valid-format
        one. Callers that must reject a bad id (e.g. ``voice.select``)
        should call ``get`` directly instead.
        """
        try:
            return self.get(voice_id)
        except ValueError:
            log.warning(
                "voice_store.get_or_default fallback=default reason=invalid_voice_id voice_id=%r",
                voice_id,
            )
            return self.get(None)

    def create(
        self, ref_wav: np.ndarray, sr: int, name: str, description: str = "",
        tags: list[str] | None = None, language: str = "",
    ) -> dict:
        """Persist ``ref_wav`` as a new voice pack's reference clip.

        Rejects a too-short clip with a typed ``ValueError`` before any
        filesystem work, and leaves no orphaned pack dir if pack-building
        fails partway through (see ``_build_pack``).
        """
        duration_s = ref_wav.size / sr if sr > 0 else 0.0
        if not duration_s > _MIN_REF_SECONDS:
            log.warning(
                "voice_store.create reject reason=clip_too_short duration_s=%.2f min_s=%.1f",
                duration_s, _MIN_REF_SECONDS,
            )
            raise ValueError(
                f"reference clip too short: need >{_MIN_REF_SECONDS:.0f}s, got {duration_s:.2f}s"
            )

        voice_id = uuid.uuid4().hex
        log.info(
            "voice_store.create start voice_id=%s name=%s samples=%d sr=%d",
            voice_id, name, ref_wav.size, sr,
        )
        created_at, ref_duration_ms = self._build_pack(
            voice_id, ref_wav, sr, name, duration_s, description, tags, language
        )

        log.info(
            "voice_store.create done voice_id=%s ref_duration_ms=%d",
            voice_id, ref_duration_ms,
        )
        return {"voiceId": voice_id, "name": name, "createdAt": created_at}

    def _build_pack(
        self, voice_id: str, ref_wav: np.ndarray, sr: int, name: str, duration_s: float,
        description: str, tags: list[str] | None, language: str,
    ) -> tuple[float, int]:
        """mkdir -> write ref.wav -> write meta, all-or-nothing.

        On any exception mid-sequence, removes the (possibly partial) pack
        dir before re-raising, so a failed ``create()`` never leaves an
        orphaned ``<voice_dir>/<uuid>/`` behind.
        """
        pack_dir = self._pack_dir(voice_id)
        try:
            pack_dir.mkdir(parents=True, exist_ok=True)
            self._write_ref_atomic(pack_dir / REF_FILENAME, ref_wav, sr)

            created_at = time.time()
            ref_duration_ms = round(duration_s * 1000.0)
            meta = {
                "name": name, "description": description, "tags": list(tags or []),
                "language": language,
                "createdAt": created_at, "refDurationMs": ref_duration_ms,
            }
            self._write_meta_atomic(pack_dir / META_FILENAME, meta)
        except Exception:
            log.warning(
                "voice_store.create failed voice_id=%s — removing orphaned pack dir",
                voice_id,
            )
            shutil.rmtree(pack_dir, ignore_errors=True)
            raise
        return created_at, ref_duration_ms

    def list(self) -> list[dict]:
        """Return metadata for every voice pack, built-ins first, each tagged ``source``."""
        builtin_packs = self._builtin.list_metas()
        packs: list[dict] = list(builtin_packs)
        if self._voice_dir.is_dir():
            for entry in sorted(self._voice_dir.iterdir()):
                if not entry.is_dir():
                    continue
                meta = read_pack_meta(entry)
                if meta is not None:
                    packs.append({**meta, "source": "user"})
        log.debug("voice_store.list count=%d builtin=%d", len(packs), len(builtin_packs))
        return packs

    def delete(self, voice_id: str) -> bool:
        """Remove a voice pack; ``False`` if it didn't exist.

        Raises ``ValueError("builtin-voice")`` for a built-in slug — the
        library is read-only, by design.
        """
        if self._builtin.has(voice_id):
            log.warning("voice_store.delete refused reason=builtin voice_id=%s", voice_id)
            raise ValueError("builtin-voice")
        pack_dir = self._validated_pack_dir(voice_id)
        if not pack_dir.is_dir():
            log.debug("voice_store.delete missing voice_id=%s", voice_id)
            return False
        shutil.rmtree(pack_dir)
        log.info("voice_store.delete done voice_id=%s", voice_id)
        return True

    def _pack_dir(self, voice_id: str) -> Path:
        return self._voice_dir / voice_id

    def _validated_pack_dir(self, voice_id: str) -> Path:
        """Resolve ``voice_id`` to its pack dir, rejecting path traversal.

        Called for every non-built-in ``voice_id`` in ``get``/``delete`` —
        NOT ``create``, which mints the id itself. Raises ``ValueError``
        for anything that isn't a bare ``uuid4().hex`` (e.g.
        ``"../../etc/passwd"``, wrong length/alphabet), plus a
        belt-and-suspenders resolved-path check so a future regex bug
        can't turn into a traversal.
        """
        self._validate_voice_id(voice_id)
        pack_dir = self._pack_dir(voice_id)
        if not pack_dir.resolve().is_relative_to(self._voice_dir.resolve()):
            raise ValueError("invalid voice_id")
        return pack_dir

    @staticmethod
    def _validate_voice_id(voice_id: str) -> None:
        """Reject any ``voice_id`` that isn't a bare ``uuid4().hex`` string."""
        if not _VOICE_ID_RE.match(voice_id):
            raise ValueError("invalid voice_id")

    @staticmethod
    def _write_ref_atomic(path: Path, ref_wav: np.ndarray, sr: int) -> None:
        """Write ``ref_wav`` via ``soundfile.write`` to a temp file, then atomically rename."""
        tmp_path = Path(f"{path}{_TMP_SUFFIX}")
        sf.write(tmp_path, ref_wav, sr, format=_REF_SF_FORMAT)
        os.replace(tmp_path, path)

    @staticmethod
    def _write_meta_atomic(path: Path, meta: dict) -> None:
        """Write ``meta`` as JSON to a temp file, then atomically rename."""
        tmp_path = Path(f"{path}{_TMP_SUFFIX}")
        tmp_path.write_text(json.dumps(meta), encoding="utf-8")
        os.replace(tmp_path, path)
