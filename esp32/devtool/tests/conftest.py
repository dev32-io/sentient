"""Shared test config: put cli/ on sys.path."""
from __future__ import annotations

import sys
from pathlib import Path


DEVTOOL_ROOT = Path(__file__).resolve().parents[1]
if str(DEVTOOL_ROOT) not in sys.path:
    sys.path.insert(0, str(DEVTOOL_ROOT))
