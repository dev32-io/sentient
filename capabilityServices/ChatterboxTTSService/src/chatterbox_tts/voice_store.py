"""Per-``voiceId`` voice-pack store for Chatterbox TTS.

A "voice pack" is a persisted Chatterbox ``Conditionals`` object (T3 +
S3Gen conditioning derived from a reference clip) plus a small metadata
record. User-created packs live one-per-directory under ``voice_dir``::

    <voice_dir>/<voiceId>/conds.safetensors   # Conditionals.save()/.load()
    <voice_dir>/<voiceId>/meta.json           # {name, description, tags, createdAt, refDurationMs}

(see ``pack_meta.py`` for the shared on-disk shape). A second, read-only
``builtin_dir`` holds packaged voice packs in the same shape, addressed
by a short slug (e.g. ``nova``) instead of a ``uuid4().hex`` — resolved
via the ``BuiltinLibrary`` collaborator (``builtin_library.py``), which
``VoiceStore`` composes and checks first in ``get``/``delete``/``list``.

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

Security notes (``voiceId`` arrives from an external boundary: webui ->
gateway -> WS ``voice.delete``/``voice.select`` -> this store):

- **Path traversal.** Every caller-supplied ``voice_id`` (``get``,
  ``delete``) is checked against the ``BuiltinLibrary`` slug set (exact
  membership) or the ``uuid4().hex`` shape (``^[0-9a-f]{32}$``, the
  format ``create()`` generates) before it ever reaches a filesystem
  path, plus a belt-and-suspenders resolved-path check. ``create()``
  mints its own id, so it skips validation.
- **Unsafe deserialization.** ``Conditionals.load()`` unpickles
  ``conds.safetensors``. Safe for user packs because the traversal
  guard pins the path under the 0700 ``voice_dir``, and every pack
  there is service-produced (an attacker never supplies pickle bytes
  directly). Safe for built-in packs because ``builtin_dir`` is
  packaged read-only content we ship, not attacker-writable. A real
  fix is migrating ``Conditionals`` to the actual safetensors format
  upstream in mlx-audio; that's a larger follow-up, not done here.
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
from typing import TYPE_CHECKING, Any

import numpy as np
from mlx_audio.tts.models.chatterbox_turbo import Conditionals

from .builtin_library import BuiltinLibrary
from .pack_meta import CONDS_FILENAME, META_FILENAME, read_pack_meta

if TYPE_CHECKING:
    from .chatterbox_mlx import ChatterboxEngine

log = logging.getLogger("chatterbox_tts.voice_store")

_TMP_SUFFIX = ".tmp"
_DIR_MODE = 0o700  # service-user-only; voice packs are unpickled on load (see module docstring)

# mlx-audio's ChatterboxEngine.prepare_conditionals() (chatterbox_turbo.py)
# hard-asserts `len(ref_wav_24k) / S3GEN_SR > 5.0` and raises a raw
# AssertionError otherwise. We reject short clips ourselves, before any
# filesystem work, so the caller gets a typed ValueError instead.
_MIN_REF_SECONDS = 5.0

# uuid.uuid4().hex shape — exactly what create() generates. Anything else
# (path separators, "..", absolute paths, wrong length/alphabet) is rejected
# before it can reach a filesystem path; see _validate_voice_id.
_VOICE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class VoiceStore:
    """Create/list/get/delete voice packs under ``voice_dir``, plus a
    read-only ``builtin_dir`` merged in ahead of them (see module docstring)."""

    def __init__(
        self, model: "ChatterboxEngine", voice_dir: Path, builtin_dir: Path | None = None
    ) -> None:
        self._model = model
        self._voice_dir = Path(voice_dir)
        self._cache: dict[str, Any] = {}  # voiceId -> loaded Conditionals
        self._builtin = BuiltinLibrary(builtin_dir)

        # Voice packs are unpickled on load (see module docstring). Lock the
        # directory to service-user-only so nothing else on the host can
        # plant or tamper with a pack. mode= on makedirs is subject to
        # umask, so chmod explicitly for both the fresh- and already-exists
        # cases.
        os.makedirs(self._voice_dir, mode=_DIR_MODE, exist_ok=True)
        os.chmod(self._voice_dir, _DIR_MODE)

    def get(self, voice_id: str | None) -> Any:
        """Return conditioning for ``voice_id``, or the model's built-in default."""
        if voice_id is None:
            log.debug("voice_store.get default reason=voice_id_none")
            return self._model.default_conditionals()

        if self._builtin.has(voice_id):
            return self._get_from_dir(voice_id, self._builtin.pack_dir(voice_id))

        # Validate untrusted input before consulting any keyed state (cache
        # included) — see module docstring's "Path traversal" note.
        pack_dir = self._validated_pack_dir(voice_id)
        return self._get_from_dir(voice_id, pack_dir)

    def _get_from_dir(self, voice_id: str, pack_dir: Path) -> Any:
        """Cache/load body shared by both the built-in and user-pack paths."""
        if voice_id in self._cache:
            log.debug("voice_store.get cache_hit voice_id=%s", voice_id)
            return self._cache[voice_id]

        conds_path = pack_dir / CONDS_FILENAME
        if not conds_path.is_file():
            log.warning(
                "voice_store.get fallback=default reason=unknown_voice voice_id=%s",
                voice_id,
            )
            return self._model.default_conditionals()

        # SECURITY: unpickles. Safe only because callers only reach here via a
        # validated pack_dir (traversal-checked, or a membership-checked
        # built-in slug) — see the "Unsafe deserialization" module docstring note.
        conds = Conditionals.load(conds_path)
        self._cache[voice_id] = conds
        log.info("voice_store.get loaded voice_id=%s path=%s", voice_id, conds_path)
        return conds

    def get_or_default(self, voice_id: str | None) -> Any:
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
        self, ref_wav: np.ndarray, sr: int, name: str, description: str = "", tags: list[str] | None = None
    ) -> dict:
        """Build conditioning from ``ref_wav`` and persist a new voice pack.

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
        conds, created_at, ref_duration_ms = self._build_pack(
            voice_id, ref_wav, sr, name, duration_s, description, tags
        )

        self._cache[voice_id] = conds
        log.info(
            "voice_store.create done voice_id=%s ref_duration_ms=%d",
            voice_id, ref_duration_ms,
        )
        return {"voiceId": voice_id, "name": name, "createdAt": created_at}

    def _build_pack(
        self, voice_id: str, ref_wav: np.ndarray, sr: int, name: str, duration_s: float,
        description: str, tags: list[str] | None,
    ) -> tuple[Any, float, int]:
        """mkdir -> prepare_conditionals -> save conds -> write meta, all-or-nothing.

        On any exception mid-sequence, removes the (possibly partial) pack
        dir before re-raising, so a failed ``create()`` never leaves an
        orphaned ``<voice_dir>/<uuid>/`` behind.
        """
        pack_dir = self._pack_dir(voice_id)
        try:
            pack_dir.mkdir(parents=True, exist_ok=True)

            # Mutates the shared lru_cache'd model singleton's `_conds` as a
            # side effect of ChatterboxEngine.prepare_conditionals() (see
            # that method's docstring in chatterbox_mlx.py) — not made
            # thread-safe here; the WS server task is expected to
            # serialize calls.
            conds = self._model.prepare_conditionals(ref_wav, sr)
            self._save_atomic(pack_dir / CONDS_FILENAME, conds)

            created_at = time.time()
            ref_duration_ms = round(duration_s * 1000.0)
            meta = {
                "name": name, "description": description, "tags": list(tags or []),
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
        return conds, created_at, ref_duration_ms

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
        self._cache.pop(voice_id, None)
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
