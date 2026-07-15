"""Entry point for ``python -m local_tts``.

Mirrors ``whisper_stt/__main__.py``'s shape: read container/host-internal
paths from ``LOCAL_TTS_*`` env vars (never hardcoded, never in
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

from .config import Config, load_config
from .event_logger import prune_old_logs
from .engine import QwenEngine
from .server import run_server
from .synth_executor import SynthExecutor
from .voice_store import VoiceStore

_LOG = logging.getLogger("local_tts")

# Default data root when no LOCAL_TTS_* env var overrides it.
_DEFAULT_DATA_DIR = Path.home() / ".sentient" / "local-tts"

# Read-only built-in voice library shipped inside the package itself
# (not under _DEFAULT_DATA_DIR — it's packaged content, not host state).
_PACKAGED_BUILTIN_DIR = Path(__file__).parent / "voices_library"


def _resolve_dir(configured: str, env_var: str, default: Path) -> Path:
    """Resolve a path field that may be empty in config.yaml.

    Empty string in config.yaml means "read the matching
    LOCAL_TTS_* env var instead" (see config/config.example.yaml).
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
        "LOCAL_TTS_CONFIG_PATH", str(_DEFAULT_DATA_DIR / "config" / "config.yaml")
    )
    return load_config(config_path)


def _resolve_and_freshen_config(config: Config) -> Config:
    """Resolve ``voice_dir``/``log_dir``/``builtin_voice_dir`` env fallbacks and prune old logs.

    ``load_config`` keeps these fields as the raw (possibly empty) YAML
    strings — resolving the ``LOCAL_TTS_*`` env fallback is
    deliberately this module's job, not ``config.py``'s (see that
    module's docstring). Returns a new ``Config`` with each field
    replaced by its resolved absolute path so every downstream consumer
    (engine, voice store, servers) sees a ready-to-use path.
    """
    log_dir = _resolve_dir(config.log_dir, "LOCAL_TTS_LOG_DIR", _DEFAULT_DATA_DIR / "logs")
    voice_dir = _resolve_dir(
        config.voice_dir, "LOCAL_TTS_VOICE_DIR", _DEFAULT_DATA_DIR / "voices"
    )
    builtin_voice_dir = _resolve_dir(
        config.builtin_voice_dir, "LOCAL_TTS_BUILTIN_VOICE_DIR", _PACKAGED_BUILTIN_DIR
    )
    log_dir.mkdir(parents=True, exist_ok=True)
    prune_old_logs(log_dir, config.retention_days)
    return replace(
        config, log_dir=str(log_dir), voice_dir=str(voice_dir),
        builtin_voice_dir=str(builtin_voice_dir),
    )


def main() -> None:
    """Load config, build + warm the engine, run the service until shutdown."""
    config = _resolve_and_freshen_config(_load_startup_config())

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    _LOG.info(
        "local-tts starting: model=%s default_lang=%s server=%s:%s health_port=%s "
        "log_dir=%s voice_dir=%s builtin_voice_dir=%s",
        config.model, config.default_lang, config.server.host, config.server.port,
        config.health.port, config.log_dir, config.voice_dir, config.builtin_voice_dir,
    )

    engine = QwenEngine(config.model, default_lang=config.default_lang)
    # All MLX work runs on the executor's single thread — including warm —
    # because MLX binds array stream affinity per-thread (see
    # synth_executor.py). start_and_warm() blocks here until warm completes
    # ON that thread and re-raises any warm error (fail-closed: aborts
    # startup before any connection is accepted).
    executor = SynthExecutor(engine)
    _LOG.info("warming model on the MLX thread (fail-closed: aborts startup on failure)...")
    executor.start_and_warm()
    _LOG.info("model warm; ready to accept connections")

    voice_store = VoiceStore(engine, Path(config.voice_dir), builtin_dir=Path(config.builtin_voice_dir))

    asyncio.run(run_server(config, executor, voice_store))


if __name__ == "__main__":
    main()
