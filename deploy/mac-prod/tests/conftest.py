"""Make `setup-prod.py` importable as `setup_prod`.

The installer keeps its hyphenated filename because operators invoke it as a
script (`sudo python3 deploy/mac-prod/setup-prod.py install ...`), and a hyphen
is not a legal module name. Loading it explicitly here — and registering it in
`sys.modules` before any test module is imported — lets the tests use the
ordinary `from setup_prod import ...` form without renaming the operator-facing
entry point.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

INSTALLER = Path(__file__).resolve().parent.parent / "setup-prod.py"

# Never cache this module's bytecode. Python invalidates a .pyc on (mtime, size),
# and an edit that preserves BOTH — e.g. mutation-testing `"local-tts"` into
# `"local_tts"` and reverting within the same second — silently serves the stale
# copy. That produced one false test result already: a mutation appeared to
# survive a revert. Bytecode buys nothing for a module loaded once per session.
sys.dont_write_bytecode = True


def _load_installer() -> None:
    spec = importlib.util.spec_from_file_location("setup_prod", INSTALLER)
    if spec is None or spec.loader is None:  # pragma: no cover - build-config error
        raise RuntimeError(f"cannot load installer module from {INSTALLER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["setup_prod"] = module
    spec.loader.exec_module(module)


_load_installer()
