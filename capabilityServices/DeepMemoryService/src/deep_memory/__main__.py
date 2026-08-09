"""Entry point for ``python -m deep_memory``.

Wires paths from the environment (set by the native launcher), loads config,
configures logging, reads the two bearer tokens from the environment, and hands
off to the blocking server. Deliberately minimal — logic lives in the modules.
"""

from __future__ import annotations

import os
from pathlib import Path

from .auth import load_tokens_from_env
from .config import load_config
from .logging import configure_logging, get_logger
from .server import run_server

log = get_logger("main")


def main() -> None:
    home = Path.home()
    data = home / ".sentient" / "deep-memory"
    config_path = Path(
        os.environ.get("DEEP_MEMORY_CONFIG_PATH", str(data / "config" / "config.yaml"))
    )
    log_dir = Path(os.environ.get("DEEP_MEMORY_LOG_DIR", str(data / "logs")))

    config = load_config(config_path)
    configure_logging(config.logging.level, log_dir, config.logging.retention_days)

    # Fail loud at startup if either bearer token is unset — never come up open.
    tokens = load_tokens_from_env()

    log.info("deep-memory starting index_schema_version=%d", config.index.schema_version)
    run_server(config, tokens)


if __name__ == "__main__":
    main()
