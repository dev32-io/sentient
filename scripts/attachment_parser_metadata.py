#!/usr/bin/env python3
"""Validate attachment-parser addon metadata for local/release image builds."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

NAME = "attachment-parser"
PROTOCOL_VERSION = 2
STATE = "ephemeral"
MAX_VERSION_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 256
REQUIRED_KEYS = frozenset({"name", "version", "protocolVersion", "description", "state"})

# SemVer 2.0.0. Docker-tag derivation is separate: only '+' is mapped to '_'
# after this canonical manifest has been validated.
_IDENTIFIER = r"(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
_VERSION_RE = re.compile(
    rf"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    rf"(?:-(?:{_IDENTIFIER})(?:\.(?:{_IDENTIFIER}))*)?"
    rf"(?:\+(?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?"
)
VERSION_RE = _VERSION_RE


def validate_metadata(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("parser metadata must be a JSON object")
    if set(value) != REQUIRED_KEYS:
        raise ValueError("parser metadata must contain exactly name, version, protocolVersion, description, state")
    if value.get("name") != NAME:
        raise ValueError(f"parser metadata name must be {NAME}")
    version = value.get("version")
    if (
        not isinstance(version, str)
        or len(version) > MAX_VERSION_LENGTH
        or _VERSION_RE.fullmatch(version) is None
    ):
        raise ValueError("parser metadata version must be SemVer (maximum 64 characters)")
    if type(value.get("protocolVersion")) is not int or value["protocolVersion"] != PROTOCOL_VERSION:
        raise ValueError(f"parser metadata protocolVersion must be {PROTOCOL_VERSION}")
    description = value.get("description")
    if not isinstance(description, str) or not 1 <= len(description) <= MAX_DESCRIPTION_LENGTH:
        raise ValueError("parser metadata description must be 1..256 characters")
    if value.get("state") != STATE:
        raise ValueError(f"parser metadata state must be {STATE}")
    return value


def read_metadata(path: Path) -> tuple[str, str, int, str]:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"cannot read parser metadata: {error}") from error
    validate_metadata(value)
    return NAME, value["version"], PROTOCOL_VERSION, STATE


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(f"usage: {Path(argv[0]).name} PATH", file=sys.stderr)
        return 2
    try:
        name, version, protocol_version, state = read_metadata(Path(argv[1]))
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"{name}\t{version}\t{protocol_version}\t{state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
