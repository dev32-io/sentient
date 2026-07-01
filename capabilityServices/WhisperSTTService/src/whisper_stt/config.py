"""Typed configuration loader — YAML on disk → frozen dataclass in memory.

This module is the ONE place the service reads ``config.yaml``. Every
other module takes a ``Config`` object (or one of its sub-sections) as a
constructor argument. That rule is the whole reason the service has no
"magic numbers" — constants live in YAML, get parsed here, and flow
through the codebase as regular Python values.

Design notes for anyone new to Python:

1. ``@dataclass(frozen=True)`` is Python's closest analogue to Kotlin's
   ``data class`` with ``val`` fields. ``frozen=True`` prevents any
   mutation after construction, which gives us the "read once at
   startup, never change" semantics we want for config.

2. ``from __future__ import annotations`` (the first real line of the
   file) asks Python to treat every type hint as a string and only
   evaluate it when a tool actually asks for it. This has two practical
   benefits: (a) faster startup, (b) you can forward-reference classes
   defined later in the same file. Consider it boilerplate — it's the
   default in Python 3.14 and later.

3. We raise a ``ConfigError`` (a plain subclass of ``ValueError``) with
   a precise, human-readable message on any validation failure. There
   is deliberately no "use a default" fallback — silent defaults are
   the #1 source of "why is my service behaving weird" bugs. If you
   delete a key from ``config.yaml``, the service crashes at startup
   with exactly which key is missing. Loud-and-early beats quiet-and-
   later, every time.

4. The loader itself is ~50 lines. The rest of this file is dataclass
   declarations that mirror the YAML schema 1:1. If you want to add a
   new knob, add a field to the matching dataclass, add a line to the
   matching ``_require`` call in ``_parse``, update ``config.example.yaml``
   with a comment — done. The config file and the dataclass tree must
   match; there is no middle layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


# Default retention window when ``logging.retention_days`` is omitted from
# config.yaml. Keeps existing deployments safe without forcing a config
# edit. New deployments should set the key explicitly via the example file.
DEFAULT_LOGGING_RETENTION_DAYS = 7

# Maximum allowed retention window in days. Above this we assume a typo.
MAX_LOGGING_RETENTION_DAYS = 365

# Default minimum speech duration when ``vad.min_speech_duration_ms`` is
# omitted from config.yaml. Existing Pi deployments without this key keep
# working; new deployments should set it explicitly via the example file.
DEFAULT_MIN_SPEECH_DURATION_MS = 200

# Upper bound — anything past this rejects every conceivable real human
# command ("no" ~250 ms, "yes" ~300 ms, "stop" ~400 ms). Above this we
# assume a typo.
MAX_MIN_SPEECH_DURATION_MS = 1000

# -----------------------------------------------------------------------------
# Error type
# -----------------------------------------------------------------------------


class ConfigError(ValueError):
    """Raised when ``config.yaml`` is missing, malformed, or incomplete.

    Subclassing ``ValueError`` means callers who catch ``ValueError``
    (the stdlib's generic "bad input" exception) also catch our config
    errors, while callers who want to specifically handle config
    problems can catch this class.
    """


# -----------------------------------------------------------------------------
# Dataclasses — one per top-level YAML section. Immutable by default.
# -----------------------------------------------------------------------------


@dataclass(frozen=True)
class ServerConfig:
    """WebSocket server bind settings."""

    host: str
    port: int
    max_frame_bytes: int


@dataclass(frozen=True)
class VadConfig:
    """Silero VAD — first-pass voice activity detection."""

    threshold: float
    min_silence_ms: int
    speech_pad_ms: int
    pre_speech_chunks: int
    silent_timeout_ms: int
    max_turn_duration_ms: int
    # Hard floor on accepted turn audio duration. Turns whose total
    # speech audio is shorter than this are rejected before SenseVoice
    # decode runs (saves ~80–200 ms per false positive). Defends against
    # short echo bursts / acoustic transients that fool Silero. Real
    # human commands like "no" / "yes" / "stop" run 250–500 ms, so 200
    # threads the needle. 0 disables the filter.
    min_speech_duration_ms: int


@dataclass(frozen=True)
class SmartTurnConfig:
    """Smart-Turn v3 — end-of-turn classifier."""

    decision_threshold: float
    intra_op_threads: int


@dataclass(frozen=True)
class SenseVoiceConfig:
    """SenseVoice-Small — the STT model."""

    num_threads: int
    use_itn: bool


@dataclass(frozen=True)
class RecordingsConfig:
    """Turn recording — persist finalized turns as WAV files on disk."""

    enabled: bool


@dataclass(frozen=True)
class LoggingConfig:
    """Logging + metrics sampling."""

    level: str
    metrics_interval_ms: int
    retention_days: int


@dataclass(frozen=True)
class Config:
    """Root configuration — contains every sub-section and the paths
    determined from environment variables (set by the Dockerfile).

    Paths are NOT in ``config.yaml`` on purpose: they are container-
    internal, fixed by the Dockerfile, and must match the volume
    mounts declared in ``deploy/mac-prod/docker-compose.yml``. Putting them
    in a third place would create a three-way sync footgun.
    """

    server: ServerConfig
    vad: VadConfig
    smart_turn: SmartTurnConfig
    sense_voice: SenseVoiceConfig
    recordings: RecordingsConfig
    logging: LoggingConfig
    model_dir: Path
    log_dir: Path
    recording_dir: Path


# -----------------------------------------------------------------------------
# Loader
# -----------------------------------------------------------------------------


def load_config(
    config_path: Path,
    *,
    model_dir: Path,
    log_dir: Path,
    recording_dir: Path,
) -> Config:
    """Read ``config.yaml`` and return a validated, frozen ``Config``.

    ``*`` in the signature above marks everything after it as
    keyword-only. Callers MUST write ``load_config(path, model_dir=...,
    log_dir=..., recording_dir=...)`` — positional ``load_config(path,
    m, l, r)`` won't compile. This is the Python idiom for "these
    arguments are too similar to pass positionally without a mistake".

    Raises ``ConfigError`` on any missing key, wrong type, or parse
    failure, with a message pointing at the exact problem.
    """
    if not config_path.is_file():
        raise ConfigError(
            f"config file not found at {config_path}. "
            "Did you bind-mount ~/.sentient/stt-service/config/config.yaml "
            "into the container?"
        )

    # ``yaml.safe_load`` refuses to instantiate arbitrary Python objects
    # from tags like ``!!python/object:...``, which is the "don't load
    # untrusted YAML with the unsafe loader" default. Always use it.
    try:
        raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ConfigError(f"failed to parse {config_path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ConfigError(
            f"{config_path}: top-level YAML must be a mapping, got {type(raw).__name__}"
        )

    return _parse(
        raw,
        model_dir=model_dir,
        log_dir=log_dir,
        recording_dir=recording_dir,
    )


def _parse(
    raw: dict[str, Any],
    *,
    model_dir: Path,
    log_dir: Path,
    recording_dir: Path,
) -> Config:
    """Walk the parsed YAML dict and build the ``Config`` tree.

    Every ``_require(...)`` call enforces "this key must exist at this
    path and be of this type". On failure it raises ``ConfigError``
    with a breadcrumb trail like ``vad.threshold``.
    """
    server_raw = _require_section(raw, "server")
    vad_raw = _require_section(raw, "vad")
    smart_turn_raw = _require_section(raw, "smart_turn")
    sense_voice_raw = _require_section(raw, "sense_voice")
    recordings_raw = _require_section(raw, "recordings")
    logging_raw = _require_section(raw, "logging")

    return Config(
        server=ServerConfig(
            host=_require(server_raw, "server.host", str),
            port=_require(server_raw, "server.port", int),
            max_frame_bytes=_require(server_raw, "server.max_frame_bytes", int),
        ),
        vad=VadConfig(
            threshold=_require(vad_raw, "vad.threshold", float),
            min_silence_ms=_require(vad_raw, "vad.min_silence_ms", int),
            speech_pad_ms=_require(vad_raw, "vad.speech_pad_ms", int),
            pre_speech_chunks=_require(vad_raw, "vad.pre_speech_chunks", int),
            silent_timeout_ms=_require(vad_raw, "vad.silent_timeout_ms", int),
            max_turn_duration_ms=_require(vad_raw, "vad.max_turn_duration_ms", int),
            min_speech_duration_ms=_require_min_speech_duration_ms(vad_raw),
        ),
        smart_turn=SmartTurnConfig(
            decision_threshold=_require(smart_turn_raw, "smart_turn.decision_threshold", float),
            intra_op_threads=_require(smart_turn_raw, "smart_turn.intra_op_threads", int),
        ),
        sense_voice=SenseVoiceConfig(
            num_threads=_require(sense_voice_raw, "sense_voice.num_threads", int),
            use_itn=_require(sense_voice_raw, "sense_voice.use_itn", bool),
        ),
        recordings=RecordingsConfig(
            enabled=_require(recordings_raw, "recordings.enabled", bool),
        ),
        logging=LoggingConfig(
            level=_require(logging_raw, "logging.level", str).lower(),
            metrics_interval_ms=_require(logging_raw, "logging.metrics_interval_ms", int),
            retention_days=_require_retention_days(logging_raw),
        ),
        model_dir=model_dir,
        log_dir=log_dir,
        recording_dir=recording_dir,
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

    ``path`` is a dotted breadcrumb like ``vad.threshold`` used only
    for error messages — the actual lookup happens on ``section`` with
    the last segment of the path. We accept ``int`` where ``float`` is
    expected because YAML writes ``0.5`` as float and ``2000`` as int,
    and a config author who writes ``threshold: 1`` shouldn't have to
    know to write ``1.0``.
    """
    key = path.rsplit(".", 1)[-1]
    if key not in section:
        raise ConfigError(f"config.yaml: missing required key '{path}'")

    value = section[key]

    # Python gotcha: ``bool`` is a subclass of ``int``, so
    # ``isinstance(True, int)`` is ``True``. We must check bool BEFORE
    # int or we'd accept ``True`` as a valid integer.
    if expected_type is bool:
        if not isinstance(value, bool):
            raise ConfigError(
                f"config.yaml: '{path}' must be a bool (true/false), "
                f"got {type(value).__name__}"
            )
        return value

    if expected_type is float:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ConfigError(
                f"config.yaml: '{path}' must be a number, "
                f"got {type(value).__name__}"
            )
        return float(value)

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


def _require_min_speech_duration_ms(section: dict[str, Any]) -> int:
    """Read ``vad.min_speech_duration_ms`` with a documented default and range check.

    Defaults to ``DEFAULT_MIN_SPEECH_DURATION_MS`` when missing so existing
    Pi config.yaml files keep working without an explicit edit. Wrong type
    or out-of-range still fails loud.
    """
    if "min_speech_duration_ms" not in section:
        return DEFAULT_MIN_SPEECH_DURATION_MS

    value = section["min_speech_duration_ms"]

    # bool is a subclass of int — reject explicitly so True/False can't slip in.
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(
            "config.yaml: 'vad.min_speech_duration_ms' must be an integer "
            f"between 0 and {MAX_MIN_SPEECH_DURATION_MS}, "
            f"got {type(value).__name__}: {value!r}"
        )
    if value < 0 or value > MAX_MIN_SPEECH_DURATION_MS:
        raise ConfigError(
            "config.yaml: 'vad.min_speech_duration_ms' must be an integer "
            f"between 0 and {MAX_MIN_SPEECH_DURATION_MS}, got {value}"
        )
    return value


def _require_retention_days(section: dict[str, Any]) -> int:
    """Read ``logging.retention_days`` with a documented default and range check.

    Unlike other config keys this one defaults to
    ``DEFAULT_LOGGING_RETENTION_DAYS`` instead of failing when missing,
    so existing config.yaml files keep working without an explicit
    value. A wrong type or out-of-range value still fails loud.
    """
    if "retention_days" not in section:
        return DEFAULT_LOGGING_RETENTION_DAYS

    value = section["retention_days"]

    # bool is a subclass of int — reject explicitly so True/False can't slip in.
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(
            "config.yaml: 'logging.retention_days' must be an integer "
            f"between 0 and {MAX_LOGGING_RETENTION_DAYS}, "
            f"got {type(value).__name__}: {value!r}"
        )
    if value < 0 or value > MAX_LOGGING_RETENTION_DAYS:
        raise ConfigError(
            "config.yaml: 'logging.retention_days' must be an integer "
            f"between 0 and {MAX_LOGGING_RETENTION_DAYS}, got {value}"
        )
    return value
