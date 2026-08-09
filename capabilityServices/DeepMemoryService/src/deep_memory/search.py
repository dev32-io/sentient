"""The pinned §5.3 search pipeline — vector + BM25 → RRF → ranked hits.

This module owns *scoring*, kept separate from *storage* (:mod:`deep_memory.index`)
so the ranking algorithm is a small, testable unit. The pipeline, exactly per
spec §5.3:

1. Per scope: vector **top-40** by cosine + FTS5/BM25 **top-40**, both already
   narrowed by the `kinds` / `statuses` / `timeRange` filters (applied in SQL,
   pre-fusion).
2. Fuse every ranked list (both signals, all scopes) by Reciprocal Rank Fusion
   with k=60; dedupe by entry id.
3. Each fused hit carries its **cosine similarity** in [0, 1] (the relevance gate
   the gateway spark path reads) and a 1-based **rank**.

`similarity = clamp(1 - cosine_distance, 0, 1)`: sqlite-vec's
``vec_distance_cosine`` returns 1 - cos in [0, 2]; subtracting from 1 recovers
the cosine, and clamping folds the (rare, for normalized embeddings) negative
tail to 0 so the gate value is always in [0, 1].
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from typing import Any

# --- Pinned pipeline constants (spec §5.3 — the pipeline's definition, not an
# operator tuning knob; changing them changes what the tuning knobs mean). -----
TOP_N = 40  # per-signal, per-scope candidate depth
RRF_K = 60  # Reciprocal Rank Fusion constant

# Token pattern for building the FTS MATCH expression. ``\w`` under Unicode
# matches CJK ideographs too, so zh queries still produce terms.
_TOKEN_RE = re.compile(r"\w+", re.UNICODE)


@dataclass(frozen=True)
class Candidate:
    """One retrieved row: entry id, its verbatim JSON, and its cosine distance."""

    entry_id: str
    entry_json: str
    dist: float


def build_fts_match(query: str) -> str | None:
    """Build an FTS5 MATCH expression that ORs the query's terms.

    Each term is wrapped as a quoted phrase (internal quotes doubled) so no query
    text can be misread as FTS operator syntax. Returns ``None`` when the query
    has no indexable terms (caller then skips the BM25 signal).
    """
    terms = _TOKEN_RE.findall(query)
    if not terms:
        return None
    quoted = ['"' + term.replace('"', '""') + '"' for term in terms]
    return " OR ".join(quoted)


def _vector_candidates(
    conn: sqlite3.Connection, qvec_blob: bytes, where_sql: str, where_params: list[Any]
) -> list[Candidate]:
    """Vector top-N: full cosine scan over the filtered entry set, nearest first."""
    sql = (
        "SELECT e.id, e.entry_json, vec_distance_cosine(v.embedding, ?) AS dist "
        "FROM entries e JOIN entries_vec v ON v.id = e.id "
        f"WHERE {where_sql} "
        "ORDER BY dist ASC LIMIT ?"
    )
    rows = conn.execute(sql, [qvec_blob, *where_params, TOP_N]).fetchall()
    return [Candidate(r[0], r[1], float(r[2])) for r in rows]


def _bm25_candidates(
    conn: sqlite3.Connection,
    qvec_blob: bytes,
    fts_match: str,
    where_sql: str,
    where_params: list[Any],
) -> list[Candidate]:
    """BM25 top-N over the filtered set; each hit also carries its cosine distance."""
    sql = (
        "SELECT e.id, e.entry_json, vec_distance_cosine(v.embedding, ?) AS dist "
        "FROM entries_fts f "
        "JOIN entries e ON e.id = f.id "
        "JOIN entries_vec v ON v.id = f.id "
        f"WHERE entries_fts MATCH ? AND {where_sql} "
        "ORDER BY bm25(entries_fts) ASC LIMIT ?"
    )
    rows = conn.execute(sql, [qvec_blob, fts_match, *where_params, TOP_N]).fetchall()
    return [Candidate(r[0], r[1], float(r[2])) for r in rows]


def reciprocal_rank_fusion(ranked_lists: list[list[str]]) -> dict[str, float]:
    """RRF over id-only ranked lists: score(id) = Σ 1/(k + rank), rank 1-based."""
    scores: dict[str, float] = {}
    for ranked in ranked_lists:
        for position, entry_id in enumerate(ranked, start=1):
            scores[entry_id] = scores.get(entry_id, 0.0) + 1.0 / (RRF_K + position)
    return scores


def _similarity(dist: float) -> float:
    return min(1.0, max(0.0, 1.0 - dist))


def search_scopes(
    conns_by_scope: dict[str, sqlite3.Connection],
    qvec_blob: bytes,
    fts_match: str | None,
    where_sql: str,
    where_params: list[Any],
    k: int,
) -> list[dict[str, Any]]:
    """Run the full §5.3 pipeline across scopes and return the top-``k`` hits.

    Each hit: ``{entry, similarity, rank}`` — ``entry`` is the stored entry
    verbatim, ``similarity`` the clamped cosine in [0, 1], ``rank`` 1-based.
    """
    import json

    ranked_lists: list[list[str]] = []
    meta: dict[str, Candidate] = {}

    for conn in conns_by_scope.values():
        vector = _vector_candidates(conn, qvec_blob, where_sql, where_params)
        ranked_lists.append([c.entry_id for c in vector])
        for cand in vector:
            meta.setdefault(cand.entry_id, cand)
        if fts_match is not None:
            bm25 = _bm25_candidates(conn, qvec_blob, fts_match, where_sql, where_params)
            ranked_lists.append([c.entry_id for c in bm25])
            for cand in bm25:
                meta.setdefault(cand.entry_id, cand)

    fused = reciprocal_rank_fusion(ranked_lists)

    # Deterministic order: RRF desc, then similarity desc, then id asc (stable
    # tie-break so identical inputs always yield identical bytes).
    ordered = sorted(
        fused.keys(),
        key=lambda eid: (-fused[eid], -_similarity(meta[eid].dist), eid),
    )

    hits: list[dict[str, Any]] = []
    for rank, entry_id in enumerate(ordered[:k], start=1):
        cand = meta[entry_id]
        hits.append(
            {
                "entry": json.loads(cand.entry_json),
                "similarity": _similarity(cand.dist),
                "rank": rank,
            }
        )
    return hits
