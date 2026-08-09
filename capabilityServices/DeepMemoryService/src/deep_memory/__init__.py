"""Deep-memory service — native (Apple Silicon / Metal) index engine.

A dumb index engine: scope ids + text in, ranked hits out. It knows nothing
about users or sessions — the gateway owns all of that and reaches this service
through a named ``DeepMemoryClient`` interface over loopback HTTP. See
``CONTRACT.md`` for the wire contract and ``docs/superpowers/specs/
2026-08-08-memory-system-design.md`` §5 for the design.

This module is the SCAFFOLD: the HTTP server, the split-credential auth plane,
and the persisted scope registry are real; the index operations
(upsert / search / set-status / purge / rebuild) run against an in-memory stub.
The real engine (SQLite + FTS5 + sqlite-vec + MLX embeddings) lands in the
next task.
"""

__version__ = "0.1.0"
