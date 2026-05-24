"""Exit codes + named errors for esp32-devtool."""
from __future__ import annotations

import json as _json

import click as _click


EXIT_OK = 0
EXIT_BAD_USAGE = 2
EXIT_BOARD_NOT_FOUND = 3
EXIT_TRANSPORT_UNAVAILABLE = 4
EXIT_VERB_ERROR = 5
EXIT_TIMEOUT = 6


class DevtoolError(Exception):
    exit_code: int = EXIT_VERB_ERROR
    next_step: str = ""

    def __init__(self, message: str, *, next_step: str = "") -> None:
        super().__init__(message)
        self.next_step = next_step or self.next_step


class BoardNotFound(DevtoolError):
    exit_code = EXIT_BOARD_NOT_FOUND


class TransportUnavailable(DevtoolError):
    exit_code = EXIT_TRANSPORT_UNAVAILABLE


class VerbError(DevtoolError):
    exit_code = EXIT_VERB_ERROR


class DevtoolTimeout(DevtoolError):
    exit_code = EXIT_TIMEOUT


def report_devtool_error(err: DevtoolError, *, json_out: bool = False) -> None:
    """Standard error rendering: text to stderr with optional next-step hint;
    JSON to stdout as a single object."""
    if json_out:
        payload = {"error": str(err), "exit_code": err.exit_code}
        if getattr(err, "next_step", None):
            payload["next_step"] = err.next_step
        _click.echo(_json.dumps(payload))
        return
    _click.echo(f"[esp32-devtool] {err}", err=True)
    if getattr(err, "next_step", None):
        _click.echo(f"   next step: {err.next_step}", err=True)
