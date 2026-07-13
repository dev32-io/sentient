"""Entry point for ``python -m chatterbox_tts``.

Mirrors ``whisper_stt/__main__.py``'s shape: read container/host-internal
paths from ``CHATTERBOX_TTS_*`` env vars (never hardcoded, never in
config.yaml — see ``config.py``'s docstring), load + validate
config.yaml, prune old logs. Config values that may be blank in
config.yaml (``voice_dir``, ``log_dir``) fall back to the matching env
var here, once, at startup.

Server startup (the WebSocket listener, health endpoint, MLX model load)
lands in a later task — this file is intentionally the scaffold those
pieces plug into, not a working service yet.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from .config import Config, load_config
from .event_logger import prune_old_logs

_LOG = logging.getLogger("chatterbox_tts")

# Default data root when no CHATTERBOX_TTS_* env var overrides it.
_DEFAULT_DATA_DIR = Path.home() / ".sentient" / "chatterbox-tts"


def _resolve_dir(configured: str, env_var: str, default: Path) -> Path:
    """Resolve a path field that may be empty in config.yaml.

    Empty string in config.yaml means "read the matching
    CHATTERBOX_TTS_* env var instead" (see config/config.example.yaml).
    Falls back to ``default`` if neither is set.
    """
    if configured:
        return Path(configured)
    env_value = os.environ.get(env_var)
    if env_value:
        return Path(env_value)
    return default


def _load_startup_config() -> Config:
    """Resolve the config file path from env and load it."""
    config_path = os.environ.get(
        "CHATTERBOX_TTS_CONFIG_PATH", str(_DEFAULT_DATA_DIR / "config" / "config.yaml")
    )
    return load_config(config_path)


def main() -> None:
    """Load config, prune old logs. Server startup lands in a later task."""
    config = _load_startup_config()

    log_dir = _resolve_dir(config.log_dir, "CHATTERBOX_TTS_LOG_DIR", _DEFAULT_DATA_DIR / "logs")
    voice_dir = _resolve_dir(
        config.voice_dir, "CHATTERBOX_TTS_VOICE_DIR", _DEFAULT_DATA_DIR / "voices"
    )

    log_dir.mkdir(parents=True, exist_ok=True)
    prune_old_logs(log_dir, config.retention_days)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    _LOG.info(
        "chatterbox-tts config loaded: model=%s server=%s:%s health_port=%s "
        "log_dir=%s voice_dir=%s (server startup lands in a later task)",
        config.model,
        config.server.host,
        config.server.port,
        config.health.port,
        log_dir,
        voice_dir,
    )


if __name__ == "__main__":
    main()
