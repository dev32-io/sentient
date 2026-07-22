"""Typed configuration loader — YAML on disk → frozen dataclass in memory.

This module is the ONE place the service reads ``config.yaml``. Every
other module takes a ``Config`` object (or one of its sub-sections) as a
constructor argument. That rule is the whole reason the service has no
"magic numbers" — constants live in YAML, get parsed here, and flow
through the codebase as regular Python values.

Mirrors the sibling ``whisper_stt/config.py`` pattern (frozen dataclass
tree + fail-loud ``require`` helpers), with one deliberate difference:
every key here is required, full stop. ``whisper_stt/config.py`` keeps
two keys defaulted for backward compatibility with pre-existing
deployments; this is a brand-new service with no legacy config.yaml to
support, so "loud-and-early" applies with no exceptions.

The generic "pull a required key of a given type/shape, raise
``ConfigError`` with a breadcrumb path on failure" helpers live in
``config_schema.py``, split out to keep this file under the project's
300-line cap — this module owns the SHAPE (the dataclass tree below and
which keys map to which types), ``config_schema.py`` owns the pulling.

Design notes for anyone new to Python — see ``whisper_stt/config.py``
for the full walkthrough of ``@dataclass(frozen=True)``, ``from
__future__ import annotations``, and why we raise instead of default.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .config_schema import ConfigError, require, require_section, require_str_choice, require_str_list

__all__ = [
    "Config",
    "ConfigError",
    "HealthConfig",
    "ServerConfig",
    "TextFrontendConfig",
    "load_config",
]


# -----------------------------------------------------------------------------
# Dataclasses — mirror the YAML schema 1:1. Immutable by default.
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class ServerConfig:
    """WebSocket server bind settings."""

    host: str
    port: int
    max_message_bytes: int


@dataclass(frozen=True)
class HealthConfig:
    """Plain-HTTP health endpoint bind settings."""

    port: int


@dataclass(frozen=True)
class TextFrontendConfig:
    """Text preprocessing before synthesis (markdown/emoji strip + TN)."""

    enabled: bool
    normalize: bool
    normalize_languages: tuple[str, ...]
    table_max_cells: int
    code_span_max_chars: int
    speak_dropped_spans: bool
    # Minimum share of a block's non-whitespace characters that must be
    # CJK (Han or kana) before ``text_frontend/normalize.py``'s
    # ``detect_lang`` treats the block as Chinese/Japanese. Range 0.0-1.0.
    cjk_ratio: float


@dataclass(frozen=True)
class Config:
    """Root configuration — every field is required; no silent defaults.

    Unlike the STT service, host paths that make sense to override per-
    deployment (``voice_dir``, ``log_dir``, ``builtin_voice_dir``) are
    plain strings here, not pre-resolved ``Path`` objects: an empty
    string is a valid value meaning "the caller (``__main__.py``) should
    fall back to the matching ``LOCAL_TTS_*`` environment variable".
    Resolving that fallback is deliberately NOT this module's job — this
    module's only job is "does config.yaml have every required key, of
    the right type". Path resolution happens once, at process startup.
    """

    schema_version: int
    model: str
    server: ServerConfig
    health: HealthConfig
    default_format: str
    default_sample_rate: int
    streaming_interval: float
    default_lang: str
    voice_dir: str
    log_dir: str
    retention_days: int
    metrics_interval_ms: int
    builtin_voice_dir: str
    voice_description_max_len: int
    voice_tag_max_len: int
    voice_max_tags: int
    text_frontend: TextFrontendConfig


# -----------------------------------------------------------------------------
# Loader
# -----------------------------------------------------------------------------


def load_config(path: str) -> Config:
    """Read ``config.yaml`` at ``path`` and return a validated, frozen ``Config``.

    Raises ``ConfigError`` on any missing key, wrong type, or parse
    failure, with a message pointing at the exact problem.
    """
    config_path = Path(path)
    if not config_path.is_file():
        raise ConfigError(
            f"config file not found at {config_path}. "
            "Did you set LOCAL_TTS_CONFIG_PATH, or copy "
            "config/config.example.yaml into place?"
        )

    # ``yaml.safe_load`` refuses to instantiate arbitrary Python objects
    # from tags like ``!!python/object:...`` — always use it over
    # ``yaml.load`` for untrusted/operator-edited YAML.
    try:
        raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ConfigError(f"failed to parse {config_path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ConfigError(
            f"{config_path}: top-level YAML must be a mapping, got {type(raw).__name__}"
        )

    return _parse(raw)


# The only languages the WFST normalizer (``text_frontend/normalize.py``)
# supports. Kept here (not imported from ``text_frontend``) because this
# module's contract is "validate config.yaml shape only" — no dependency on
# the pipeline it configures.
_VALID_NORMALIZE_LANGUAGES: frozenset[str] = frozenset({"en", "zh", "ja"})

# ``default_lang`` additionally accepts "auto" (detect per block/document —
# see ``text_frontend/normalize.py``'s ``resolve_lang``), which
# ``normalize_languages`` does not. Unvalidated, a typo like "en-US" or
# "EN" silently fell through ``resolve_lang``'s "declared in _SUPPORTED"
# check straight to detection every time, quietly discarding the
# operator's pinned language.
_VALID_DEFAULT_LANG: frozenset[str] = frozenset({"auto"}) | _VALID_NORMALIZE_LANGUAGES


def _parse(raw: dict[str, Any]) -> Config:
    """Walk the parsed YAML dict and build the ``Config`` tree.

    Every ``require(...)`` call enforces "this key must exist at this
    path and be of this type". On failure it raises ``ConfigError`` with
    a breadcrumb trail like ``server.port``.
    """
    server_raw = require_section(raw, "server")
    health_raw = require_section(raw, "health")
    text_frontend_raw = require_section(raw, "text_frontend")

    return Config(
        schema_version=require(raw, "schema_version", int),
        model=require(raw, "model", str),
        server=ServerConfig(
            host=require(server_raw, "server.host", str),
            port=require(server_raw, "server.port", int),
            max_message_bytes=require(server_raw, "server.max_message_bytes", int),
        ),
        health=HealthConfig(
            port=require(health_raw, "health.port", int),
        ),
        default_format=require(raw, "default_format", str),
        default_sample_rate=require(raw, "default_sample_rate", int),
        streaming_interval=require(raw, "streaming_interval", float),
        default_lang=require_str_choice(raw, "default_lang", _VALID_DEFAULT_LANG),
        voice_dir=require(raw, "voice_dir", str),
        log_dir=require(raw, "log_dir", str),
        retention_days=require(raw, "retention_days", int),
        metrics_interval_ms=require(raw, "metrics_interval_ms", int),
        builtin_voice_dir=require(raw, "builtin_voice_dir", str),
        voice_description_max_len=require(raw, "voice_description_max_len", int),
        voice_tag_max_len=require(raw, "voice_tag_max_len", int),
        voice_max_tags=require(raw, "voice_max_tags", int),
        text_frontend=_parse_text_frontend(text_frontend_raw),
    )


def _parse_text_frontend(text_frontend_raw: dict[str, Any]) -> TextFrontendConfig:
    """Build the ``text_frontend`` sub-tree — split out of ``_parse`` to keep
    that function under the project's 40-line function cap.
    """
    return TextFrontendConfig(
        enabled=require(text_frontend_raw, "text_frontend.enabled", bool),
        normalize=require(text_frontend_raw, "text_frontend.normalize", bool),
        normalize_languages=require_str_list(
            text_frontend_raw, "text_frontend.normalize_languages", _VALID_NORMALIZE_LANGUAGES
        ),
        table_max_cells=require(text_frontend_raw, "text_frontend.table_max_cells", int),
        code_span_max_chars=require(
            text_frontend_raw, "text_frontend.code_span_max_chars", int
        ),
        speak_dropped_spans=require(
            text_frontend_raw, "text_frontend.speak_dropped_spans", bool
        ),
        cjk_ratio=require(text_frontend_raw, "text_frontend.cjk_ratio", float),
    )
