"""Embedding backends — text in, vectors out.

The index engine (:mod:`deep_memory.index`) depends on the :class:`Embedder`
protocol, never on a concrete backend. Two implementations exist:

* :class:`MlxEmbedder` — the production backend: an MLX embedding model loaded on
  Apple-Silicon Metal. The model is **lazy-loaded** (the heavy ``mlx`` import and
  the multi-hundred-MB weight download happen inside :meth:`MlxEmbedder.load`,
  never at module import), so importing this module is cheap and the unit suite
  never touches MLX.
* A deterministic fake lives in the test tree (``tests/fake_embedder.py``) — unit
  tests inject it so index/search behaviour is exercised at zero model cost.

**Model.** ``mlx-community/multilingual-e5-small-mlx`` — 384-dim, multilingual
(the family speaks en + zh), and it returns **L2-normalized** embeddings, so a
dot product IS the cosine similarity. The e5 family expects an instruction
prefix: ``query:`` for search queries, ``passage:`` for indexed documents. Both
prefixes are applied here so callers pass raw text.

**Content discipline.** This module never logs text — only counts and the model
id (see :mod:`deep_memory.logging`).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .logging import get_logger

log = get_logger("embedder")

# e5 instruction prefixes (model contract, not a tuning knob — code constant).
_QUERY_PREFIX = "query: "
_DOC_PREFIX = "passage: "

# Token budget per text handed to the model (mlx_embeddings.generate max_length).
_MAX_LENGTH = 512


@runtime_checkable
class Embedder(Protocol):
    """Text -> vector. The index engine depends on this, not on a backend."""

    @property
    def model_id(self) -> str:
        """Stable id of the loaded model — recorded in the index, reported by /health."""
        ...

    @property
    def dim(self) -> int:
        """Embedding dimensionality — the width of the sqlite-vec vector column."""
        ...

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """Embed indexed documents (passage side). Returns one vector per text."""
        ...

    def embed_query(self, text: str) -> list[float]:
        """Embed a single search query (query side)."""
        ...


class MlxEmbedder:
    """Production embedder — an MLX multilingual embedding model on Metal.

    The model loads lazily: constructing an ``MlxEmbedder`` is free, the weights
    load on first embed call or an explicit :meth:`load`. ``dim`` is derived from
    the model config at load, so the caller never hardcodes a width.
    """

    def __init__(self, model_id: str) -> None:
        self._model_id = model_id
        self._model = None
        self._tokenizer = None
        self._dim: int | None = None

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def dim(self) -> int:
        if self._dim is None:
            self.load()
        assert self._dim is not None
        return self._dim

    def load(self) -> None:
        """Load the model + tokenizer and probe the embedding width. Idempotent."""
        if self._model is not None:
            return
        # Heavy import is deferred to here so the module import stays cheap and
        # the unit suite (which injects a fake) never pulls MLX.
        from mlx_embeddings import generate, load  # noqa: PLC0415

        log.info("embedder loading model_id=%s", self._model_id)
        self._model, self._tokenizer = load(self._model_id)
        self._generate = generate
        probe = self._embed([_QUERY_PREFIX + "dimension probe"])
        self._dim = len(probe[0])
        log.info("embedder loaded model_id=%s dim=%d", self._model_id, self._dim)

    def _embed(self, prefixed_texts: list[str]) -> list[list[float]]:
        if self._model is None:
            self.load()
        out = self._generate(
            self._model, self._tokenizer, prefixed_texts, max_length=_MAX_LENGTH
        )
        # text_embeds is an mlx array (rows x dim), already L2-normalized.
        return [[float(x) for x in row] for row in out.text_embeds.tolist()]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return self._embed([_DOC_PREFIX + t for t in texts])

    def embed_query(self, text: str) -> list[float]:
        return self._embed([_QUERY_PREFIX + text])[0]
