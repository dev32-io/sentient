"""Typed configuration loader — YAML on disk → frozen dataclass in memory.

This module is the ONE place the service reads ``config.yaml``. Every
other module takes a ``Config`` object (or one of its sub-sections) as a
constructor argument. That rule is the whole reason the service has no
"magic numbers" — constants live in YAML, get parsed here, and flow
through the codebase as regular Python values.

Mirrors the sibling ``whisper_stt/config.py`` pattern (frozen dataclass
tree + fail-loud ``_require`` helpers), with one deliberate difference:
every key here is required, full stop. ``whisper_stt/config.py`` keeps
two keys defaulted for backward compatibility with pre-existing
deployments; this is a brand-new service with no legacy config.yaml to
support, so "loud-and-early" applies with no exceptions.

Design notes for anyone new to Python — see ``whisper_stt/config.py``
for the full walkthrough of ``@dataclass(frozen=True)``, ``from
__future__ import annotations``, and why we raise instead of default.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


# -----------------------------------------------------------------------------
# Error type
# -----------------------------------------------------------------------------


class ConfigError(ValueError):
    """Raised when ``config.yaml`` is missing, malformed, or incomplete.

    Subclassing ``ValueError`` means callers who catch ``ValueError``
    also catch our config errors, while callers who want to specifically
    handle config problems can catch this class.
    """


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
class Config:
    """Root configuration — every field is required; no silent defaults.

    Unlike the STT service, host paths that make sense to override per-
    deployment (``voice_dir``, ``log_dir``, ``builtin_voice_dir``) are
    plain strings here, not pre-resolved ``Path`` objects: an empty
    string is a valid value meaning "the caller (``__main__.py``) should
    fall back to the matching ``CHATTERBOX_TTS_*`` environment variable".
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
            "Did you set CHATTERBOX_TTS_CONFIG_PATH, or copy "
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


def _parse(raw: dict[str, Any]) -> Config:
    """Walk the parsed YAML dict and build the ``Config`` tree.

    Every ``_require(...)`` call enforces "this key must exist at this
    path and be of this type". On failure it raises ``ConfigError`` with
    a breadcrumb trail like ``server.port``.
    """
    server_raw = _require_section(raw, "server")
    health_raw = _require_section(raw, "health")

    return Config(
        schema_version=_require(raw, "schema_version", int),
        model=_require(raw, "model", str),
        server=ServerConfig(
            host=_require(server_raw, "server.host", str),
            port=_require(server_raw, "server.port", int),
            max_message_bytes=_require(server_raw, "server.max_message_bytes", int),
        ),
        health=HealthConfig(
            port=_require(health_raw, "health.port", int),
        ),
        default_format=_require(raw, "default_format", str),
        default_sample_rate=_require(raw, "default_sample_rate", int),
        streaming_interval=_require(raw, "streaming_interval", float),
        default_lang=_require(raw, "default_lang", str),
        voice_dir=_require(raw, "voice_dir", str),
        log_dir=_require(raw, "log_dir", str),
        retention_days=_require(raw, "retention_days", int),
        metrics_interval_ms=_require(raw, "metrics_interval_ms", int),
        builtin_voice_dir=_require(raw, "builtin_voice_dir", str),
        voice_description_max_len=_require(raw, "voice_description_max_len", int),
        voice_tag_max_len=_require(raw, "voice_tag_max_len", int),
        voice_max_tags=_require(raw, "voice_max_tags", int),
    )


def _require_section(raw: dict[str, Any], name: str) -> dict[str, Any]:
    """Pull a required top-level mapping ``name`` out of ``raw``."""
    value = raw.get(name)
    if value is None:
        raise ConfigError(f"config.yaml: missing required section '{name}'")
    if not isinstance(value, dict):
        raise ConfigError(
            f"config.yaml: section '{name}' must be a mapping, got {type(value).__name__}"
        )
    return value


def _require(section: dict[str, Any], path: str, expected_type: type) -> Any:
    """Pull a required leaf value at ``path`` and assert its type.

    ``path`` is a dotted breadcrumb (e.g. ``server.port``) used only for
    error messages — the actual lookup happens on ``section`` with the
    last segment of the path. ``section`` may be the top-level mapping
    itself (for scalar fields like ``model``) or a nested section (for
    ``server.*`` / ``health.*``).
    """
    key = path.rsplit(".", 1)[-1]
    if key not in section:
        raise ConfigError(f"config.yaml: missing required key '{path}'")
    return _coerce(path, section[key], expected_type)


# Human-readable type description per expected_type, used in error messages.
_TYPE_LABELS: dict[type, str] = {
    bool: "a bool (true/false)",
    float: "a number",
    int: "an integer",
    str: "a string",
}


def _coerce(path: str, value: Any, expected_type: type) -> Any:
    """Validate ``value`` against ``expected_type`` and return it (coerced if needed).

    Python gotcha: ``bool`` is a subclass of ``int``, so
    ``isinstance(True, int)`` is ``True``. Every branch below checks
    ``bool`` explicitly (before or in place of ``int``/``float``) so
    ``true``/``false`` can never slip through as a number. We accept
    ``int`` where ``float`` is expected because YAML writes ``0.5`` as
    float and ``1`` as int, and a config author who writes
    ``streaming_interval: 1`` shouldn't have to know to write ``1.0``.
    """
    if expected_type is bool and isinstance(value, bool):
        return value
    if expected_type is float and isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if expected_type is int and isinstance(value, int) and not isinstance(value, bool):
        return value
    if expected_type is str and isinstance(value, str):
        return value

    label = _TYPE_LABELS.get(expected_type)
    if label is None:
        raise ConfigError(f"config.py internal error: unsupported expected type {expected_type}")
    raise ConfigError(f"config.yaml: '{path}' must be {label}, got {type(value).__name__}")
