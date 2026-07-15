"""Read-only built-in voice library — packs shipped alongside the service.

A built-in pack lives in the same on-disk shape as a user pack
(``ref.wav`` + ``meta.json``, see ``pack_meta.py``) but under a
separate ``builtin_dir``, addressed by a short human-readable slug (e.g.
``nova``) instead of a ``uuid4().hex``. Built-ins are read-only from the
service's point of view — there is no create/delete path, only
membership/listing/resolution — so the slug set is scanned once at
construction time rather than per call.

``BuiltinLibrary`` is a collaborator of ``VoiceStore``, not a
replacement: ``VoiceStore`` composes one instance and delegates
``has``/``pack_dir``/``list_metas`` to it, keeping the "is this id a
built-in?" question in one place.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from .pack_meta import REF_FILENAME, read_pack_meta

log = logging.getLogger("chatterbox_tts.builtin_library")

# Built-in voice slugs are short, human-readable, and shipped by us —
# distinct from the uuid4().hex shape VoiceStore validates user-supplied
# ids against. Anything else (path separators, "..", wrong length/
# alphabet) is rejected before it can reach a filesystem path.
_BUILTIN_SLUG_RE = re.compile(r"^[a-z0-9-]{1,32}$")


class BuiltinLibrary:
    """Read-only slug -> pack-dir resolver for packaged voice packs."""

    def __init__(self, builtin_dir: Path | None) -> None:
        self._builtin_dir = Path(builtin_dir) if builtin_dir is not None else None
        self._slugs = self._scan_slugs()
        log.info(
            "builtin_library.init count=%d dir=%s", len(self._slugs), self._builtin_dir,
        )

    def has(self, voice_id: str) -> bool:
        """Whether ``voice_id`` names a known built-in pack."""
        return voice_id in self._slugs

    def pack_dir(self, slug: str) -> Path:
        """Resolve ``slug`` to its pack dir, rejecting path traversal.

        Only meaningful for a slug already confirmed via ``has()`` —
        callers (``VoiceStore.get``/``.list``) always check membership
        first. Belt-and-suspenders: asserts the resolved dir is still
        inside ``builtin_dir``, same guard style as
        ``VoiceStore._validated_pack_dir``.
        """
        assert self._builtin_dir is not None  # has() can't be True without one
        pack_dir = self._builtin_dir / slug
        if not pack_dir.resolve().is_relative_to(self._builtin_dir.resolve()):
            raise ValueError("invalid voice_id")
        return pack_dir

    def list_metas(self) -> list[dict]:
        """Metadata for every built-in pack, source-tagged, slug-sorted."""
        metas: list[dict] = []
        for slug in sorted(self._slugs):
            meta = read_pack_meta(self.pack_dir(slug))
            if meta is not None:
                metas.append({**meta, "source": "builtin"})
        return metas

    def _scan_slugs(self) -> set[str]:
        """Slug set = subdirs of builtin_dir matching the slug shape, holding a ref wav."""
        if self._builtin_dir is None or not self._builtin_dir.is_dir():
            return set()
        slugs: set[str] = set()
        for entry in self._builtin_dir.iterdir():
            if entry.is_dir() and _BUILTIN_SLUG_RE.match(entry.name) and (entry / REF_FILENAME).is_file():
                slugs.add(entry.name)
        return slugs
