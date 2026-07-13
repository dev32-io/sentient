"""Entry point for ``python -m chatterbox_tts``.

Mirrors ``whisper_stt/__main__.py``'s shape: read container/host-internal
paths from ``CHATTERBOX_TTS_*`` env vars (never hardcoded, never in
config.yaml — see ``config.py``'s docstring), load + validate
config.yaml, prune old logs, then build the shared engine + voice store,
warm the model (fail-closed: a warm-up failure aborts startup before any
connection is accepted), and run the WS + health servers until a
SIGINT/SIGTERM shuts them down gracefully (see ``server.run_server``).
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import replace
from pathlib import Path

from .chatterbox_mlx import ChatterboxEngine
from .config import Config, load_config
from .event_logger import prune_old_logs
from .server import run_server
from .voice_store import VoiceStore

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


def _resolve_and_freshen_config(config: Config) -> Config:
    """Resolve ``voice_dir``/``log_dir`` env fallbacks and prune old logs.

    ``load_config`` keeps these two fields as the raw (possibly empty)
    YAML strings — resolving the ``CHATTERBOX_TTS_*`` env fallback is
    deliberately this module's job, not ``config.py``'s (see that
    module's docstring). Returns a new ``Config`` with both fields
    replaced by their resolved absolute paths so every downstream
    consumer (engine, voice store, servers) sees a ready-to-use path.
    """
    log_dir = _resolve_dir(config.log_dir, "CHATTERBOX_TTS_LOG_DIR", _DEFAULT_DATA_DIR / "logs")
    voice_dir = _resolve_dir(
        config.voice_dir, "CHATTERBOX_TTS_VOICE_DIR", _DEFAULT_DATA_DIR / "voices"
    )
    log_dir.mkdir(parents=True, exist_ok=True)
    prune_old_logs(log_dir, config.retention_days)
    return replace(config, log_dir=str(log_dir), voice_dir=str(voice_dir))


def main() -> None:
    """Load config, build + warm the engine, run the service until shutdown."""
    config = _resolve_and_freshen_config(_load_startup_config())

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    _LOG.info(
        "chatterbox-tts starting: model=%s server=%s:%s health_port=%s log_dir=%s voice_dir=%s",
        config.model, config.server.host, config.server.port, config.health.port,
        config.log_dir, config.voice_dir,
    )

    engine = ChatterboxEngine(config.model, config.exaggeration, config.cfg_weight)
    _LOG.info("warming model (fail-closed: aborts startup on failure)...")
    engine.warm()
    _LOG.info("model warm; ready to accept connections")

    voice_store = VoiceStore(engine, Path(config.voice_dir))

    asyncio.run(run_server(config, engine, voice_store))


if __name__ == "__main__":
    main()
