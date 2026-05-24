"""Resolve ${REPO_ROOT} for manifest path substitution."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


def resolve_repo_root() -> Path:
    """Walk up from CWD looking for a git root. Fall back to CWD."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        if out:
            return Path(out)
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return Path(os.getcwd())


def substitute(value: str, *, repo_root: Path | None = None) -> str:
    """Replace ${REPO_ROOT} in a string."""
    root = repo_root if repo_root is not None else resolve_repo_root()
    return value.replace("${REPO_ROOT}", str(root))
