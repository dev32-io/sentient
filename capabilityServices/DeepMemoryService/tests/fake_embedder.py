"""Deterministic, injectable embedder for zero-cost index/search unit tests.

The real MLX model is heavy (weights download + Metal). These tests inject this
fake instead so index/search behaviour is exercised without a model. Where a
test needs to *control* ranking, it passes an explicit ``vectors`` map
(text -> vector); any text not in the map gets a stable hash-derived vector so
unrelated fixtures are still deterministic.

Vectors need not be unit-length: the engine scores with ``vec_distance_cosine``,
which normalizes internally.
"""

from __future__ import annotations

import hashlib


class FakeEmbedder:
    """A fixed-dimension embedder with optional per-text vector overrides."""

    def __init__(
        self,
        *,
        model_id: str = "fake-embedder-v1",
        dim: int = 8,
        vectors: dict[str, list[float]] | None = None,
    ) -> None:
        self._model_id = model_id
        self._dim = dim
        self._vectors = vectors or {}

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def dim(self) -> int:
        return self._dim

    def _lookup(self, text: str) -> list[float]:
        if text in self._vectors:
            vec = self._vectors[text]
            if len(vec) != self._dim:
                raise ValueError(f"override vector for {text!r} has wrong dim")
            return list(vec)
        return self._hash_vector(text)

    def _hash_vector(self, text: str) -> list[float]:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        # One float per dimension, deterministic and in a stable range.
        return [((digest[i % len(digest)] / 255.0) * 2.0 - 1.0) for i in range(self._dim)]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._lookup(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._lookup(text)
