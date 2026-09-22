#!/usr/bin/env python3
"""Load and validate parser addon metadata from the authoritative manifest."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

METADATA_PATH = Path(__file__).with_name("addon.json")
_REQUIRED_KEYS = {"name", "version", "protocolVersion", "description", "state"}
_MAX_VERSION_CHARS = 64
_VERSION_RE = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


def load_metadata(path: Path = METADATA_PATH) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != _REQUIRED_KEYS:
        raise ValueError("invalid addon metadata")
    if value.get("name") != "attachment-parser":
        raise ValueError("invalid addon metadata")
    if (
        not isinstance(value.get("version"), str)
        or len(value["version"]) > _MAX_VERSION_CHARS
        or not _VERSION_RE.fullmatch(value["version"])
    ):
        raise ValueError("invalid addon metadata")
    if type(value.get("protocolVersion")) is not int or value["protocolVersion"] != 2:
        raise ValueError("invalid addon metadata")
    if not isinstance(value.get("description"), str) or not 1 <= len(value["description"]) <= 256:
        raise ValueError("invalid addon metadata")
    if value.get("state") != "ephemeral":
        raise ValueError("invalid addon metadata")
    return value


ADDON_METADATA = load_metadata()
