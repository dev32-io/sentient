"""Generic dict-schema validation helpers used by ``config.py``'s ``_parse``.

Split out of ``config.py`` purely to keep that file under the project's
300-line cap (``.claude/rules/clean-code.md``, which covers
``capabilityServices/**``) as the schema grows. Everything here is
schema-AGNOSTIC: these functions know nothing about local-tts's specific
``Config`` shape, only "pull a required key of a given type/shape out of a
mapping, raising with a breadcrumb path on failure". ``config.py`` owns
the shape; this module owns the pulling-and-checking.
"""

from __future__ import annotations

from typing import Any


class ConfigError(ValueError):
    """Raised when ``config.yaml`` is missing, malformed, or incomplete.

    Subclassing ``ValueError`` means callers who catch ``ValueError``
    also catch our config errors, while callers who want to specifically
    handle config problems can catch this class.
    """


def require_section(raw: dict[str, Any], name: str) -> dict[str, Any]:
    """Pull a required top-level mapping ``name`` out of ``raw``."""
    value = raw.get(name)
    if value is None:
        raise ConfigError(f"config.yaml: missing required section '{name}'")
    if not isinstance(value, dict):
        raise ConfigError(
            f"config.yaml: section '{name}' must be a mapping, got {type(value).__name__}"
        )
    return value


def require_str_list(section: dict[str, Any], path: str, valid_values: frozenset[str]) -> tuple[str, ...]:
    """Pull a required list-of-strings value at ``path``.

    Rejects a missing key, a non-list value, an empty list, a list
    containing a non-string entry, and any entry not in ``valid_values``.
    Returns a ``tuple`` (not a ``list``) so the value can live on a frozen
    dataclass.
    """
    key = path.rsplit(".", 1)[-1]
    if key not in section:
        raise ConfigError(f"config.yaml: missing required key '{path}'")
    value = section[key]
    if not isinstance(value, list):
        raise ConfigError(
            f"config.yaml: '{path}' must be a list of strings, got {type(value).__name__}"
        )
    if not value:
        raise ConfigError(f"config.yaml: '{path}' must not be empty")
    for entry in value:
        if not isinstance(entry, str):
            raise ConfigError(
                f"config.yaml: '{path}' entries must be strings, got {type(entry).__name__}"
            )
        if entry not in valid_values:
            raise ConfigError(
                f"config.yaml: '{path}' entry '{entry}' must be one of {sorted(valid_values)}"
            )
    return tuple(value)


def require_str_choice(section: dict[str, Any], path: str, valid_values: frozenset[str]) -> str:
    """Pull a required string value at ``path`` constrained to ``valid_values``.

    Same breadcrumb-path error style as ``require``/``require_str_list``,
    for a single-value allow-list (e.g. ``default_lang``) rather than a
    list-of-strings one.
    """
    value = require(section, path, str)
    if value not in valid_values:
        raise ConfigError(
            f"config.yaml: '{path}' must be one of {sorted(valid_values)}, got {value!r}"
        )
    return value


def require(section: dict[str, Any], path: str, expected_type: type) -> Any:
    """Pull a required leaf value at ``path`` and assert its type.

    ``path`` is a dotted breadcrumb (e.g. ``server.port``) used only for
    error messages -- the actual lookup happens on ``section`` with the
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
        raise ConfigError(f"config_schema.py internal error: unsupported expected type {expected_type}")
    raise ConfigError(f"config.yaml: '{path}' must be {label}, got {type(value).__name__}")
