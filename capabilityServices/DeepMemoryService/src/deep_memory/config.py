"""Typed configuration loader — YAML on disk -> frozen dataclass in memory.

This module is the ONE place the service reads ``config.yaml``. Every other
module takes a ``Config`` object (or a sub-section) by value. Constants live in
YAML, get parsed and validated here, and flow through the code as regular
values — there are no magic numbers in source.

There is deliberately no "use a default" fallback for structural keys: a
missing or wrong-typed key crashes at startup with the exact path that is
wrong. Loud-and-early beats quiet-and-later.

Mirrors the sibling ``whisper_stt.config`` / ``local_tts.config`` shape:
``@dataclass(frozen=True)`` sections, a ``ConfigError(ValueError)``, and a
``_require`` family that asserts presence + type with a dotted breadcrumb.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

# Upper bound on log retention — above this we assume a typo, not intent.
MAX_LOGGING_RETENTION_DAYS = 365


class ConfigError(ValueError):
    """Raised when ``config.yaml`` is missing, malformed, or incomplete."""


@dataclass(frozen=True)
class ServerConfig:
    """HTTP server bind settings. Loopback only in practice (see example)."""

    host: str
    port: int


@dataclass(frozen=True)
class StorageConfig:
    """On-disk storage roots. ``data_root`` is the scope-path boundary."""

    data_root: Path


@dataclass(frozen=True)
class EmbeddingConfig:
    """MLX embedding model the index engine loads (T9b). Pinned + swappable."""

    model: str


@dataclass(frozen=True)
class IndexConfig:
    """Versioned index schema. ``schema_version`` is reported by /health."""

    schema_version: int


@dataclass(frozen=True)
class LoggingConfig:
    """Stdout log level + file retention."""

    level: str
    retention_days: int


@dataclass(frozen=True)
class Config:
    """Root configuration — one field per top-level YAML section."""

    server: ServerConfig
    storage: StorageConfig
    embedding: EmbeddingConfig
    index: IndexConfig
    logging: LoggingConfig


def load_config(config_path: Path) -> Config:
    """Read ``config.yaml`` and return a validated, frozen ``Config``.

    Raises ``ConfigError`` on any missing key, wrong type, or parse failure,
    with a message pointing at the exact problem.
    """
    if not config_path.is_file():
        raise ConfigError(
            f"config file not found at {config_path}. "
            "Copy config/config.example.yaml to "
            "~/.sentient/deep-memory/config/config.yaml."
        )

    try:
        raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ConfigError(f"failed to parse {config_path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ConfigError(
            f"{config_path}: top-level YAML must be a mapping, "
            f"got {type(raw).__name__}"
        )

    return _parse(raw)


def _parse(raw: dict[str, Any]) -> Config:
    server_raw = _require_section(raw, "server")
    storage_raw = _require_section(raw, "storage")
    embedding_raw = _require_section(raw, "embedding")
    index_raw = _require_section(raw, "index")
    logging_raw = _require_section(raw, "logging")

    return Config(
        server=ServerConfig(
            host=_require(server_raw, "server.host", str),
            port=_require(server_raw, "server.port", int),
        ),
        storage=StorageConfig(
            data_root=_expand_path(_require(storage_raw, "storage.data_root", str)),
        ),
        embedding=EmbeddingConfig(
            model=_require(embedding_raw, "embedding.model", str),
        ),
        index=IndexConfig(
            schema_version=_require(index_raw, "index.schema_version", int),
        ),
        logging=LoggingConfig(
            level=_require(logging_raw, "logging.level", str).lower(),
            retention_days=_require_retention_days(logging_raw),
        ),
    )


def _expand_path(value: str) -> Path:
    """Expand ``~`` and resolve to an absolute path (not required to exist)."""
    return Path(value).expanduser().resolve()


def _require_section(raw: dict[str, Any], name: str) -> dict[str, Any]:
    value = raw.get(name)
    if value is None:
        raise ConfigError(f"config.yaml: missing required section '{name}'")
    if not isinstance(value, dict):
        raise ConfigError(
            f"config.yaml: section '{name}' must be a mapping, "
            f"got {type(value).__name__}"
        )
    return value


def _require(section: dict[str, Any], path: str, expected_type: type) -> Any:
    key = path.rsplit(".", 1)[-1]
    if key not in section:
        raise ConfigError(f"config.yaml: missing required key '{path}'")

    value = section[key]

    # bool is a subclass of int — check it first so True can't pass as an int.
    if expected_type is bool:
        if not isinstance(value, bool):
            raise ConfigError(
                f"config.yaml: '{path}' must be a bool (true/false), "
                f"got {type(value).__name__}"
            )
        return value

    if expected_type is int:
        if not isinstance(value, int) or isinstance(value, bool):
            raise ConfigError(
                f"config.yaml: '{path}' must be an integer, "
                f"got {type(value).__name__}"
            )
        return value

    if expected_type is str:
        if not isinstance(value, str):
            raise ConfigError(
                f"config.yaml: '{path}' must be a string, "
                f"got {type(value).__name__}"
            )
        return value

    raise ConfigError(
        f"config.py internal error: unsupported expected type {expected_type}"
    )


def _require_retention_days(section: dict[str, Any]) -> int:
    value = _require(section, "logging.retention_days", int)
    if value < 0 or value > MAX_LOGGING_RETENTION_DAYS:
        raise ConfigError(
            "config.yaml: 'logging.retention_days' must be an integer "
            f"between 0 and {MAX_LOGGING_RETENTION_DAYS}, got {value}"
        )
    return value
