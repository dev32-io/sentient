#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pyserial>=3.5",
#   "requests>=2.31",
#   "click>=8.1",
#   "pyyaml>=6.0",
#   "rich>=13",
#   "websockets>=12",
# ]
# ///
"""esp32-devtool entry point. Dispatches to cli/commands/* via click."""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure sibling modules (cli/*) are importable when invoked via uv run --script.
HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))

import click

from cli.board import BOARDS_DIR
from cli.version import __version__


@click.group(name="esp32-devtool", invoke_without_command=True)
@click.option("--board", default=None, help="Override board auto-detect.")
@click.option("--port", default=None, help="Override USB-CDC port auto-detect.")
@click.option("--http", "http_url", default=None, help="Override HTTP base URL.")
@click.option("--profile", default=None, type=click.Choice(["debug", "prod"]),
              help="Build profile (debug|prod). Defaults vary per command.")
@click.option("--repo-root", default=None, help="Override git-root inference.")
@click.option("--quiet/--no-quiet", default=False)
@click.option("--verbose/--no-verbose", default=False)
@click.option("--json", "json_out", is_flag=True, help="Machine-readable output.")
@click.option("--no-daemon", is_flag=True, help="Skip daemon; open serial per call.")
@click.version_option(__version__, prog_name="esp32-devtool")
@click.pass_context
def cli(ctx: click.Context, **kwargs) -> None:
    ctx.ensure_object(dict)
    ctx.obj.update(kwargs)
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


# Stub commands — each task below replaces these with real impls.
@cli.command()
@click.pass_context
def info(ctx: click.Context) -> None:
    from cli.commands.info import run
    sys.exit(run(ctx.obj))


@cli.command()
@click.option("--profile", default="debug", type=click.Choice(["debug", "prod"]))
@click.pass_context
def flash(ctx: click.Context, profile: str) -> None:
    from cli.commands.flash import run
    sys.exit(run(ctx.obj, profile))


@cli.command()
@click.option("--follow", "-f", is_flag=True)
@click.option("--since", default=None)
@click.option("--filter", "filter_pat", default=None)
@click.option("--source", default="all", type=click.Choice(["usb", "udp", "all"]))
@click.option("--level", default="I", type=click.Choice(["D", "I", "W", "E"]))
@click.option("--no-color", is_flag=True)
@click.option("--lines", default=100, type=int)
@click.pass_context
def logs(ctx: click.Context, follow: bool, since: str | None,
         filter_pat: str | None, source: str, level: str,
         no_color: bool, lines: int) -> None:
    from cli.commands.logs import run
    sys.exit(run(
        ctx.obj, follow, since, filter_pat, source, level, no_color, lines,
        ctx.obj.get("json_out", False),
    ))


@cli.command()
@click.option("--out", "out_path", default=None)
@click.option("--format", "fmt", default="png", type=click.Choice(["png", "jpeg", "rgb565"]))
@click.pass_context
def screenshot(ctx: click.Context, out_path: str | None, fmt: str) -> None:
    from cli.commands.screenshot import run
    sys.exit(run(ctx.obj, out_path, fmt))


@cli.command()
@click.argument("verb")
@click.option("--param", "-p", "params", multiple=True, help="k=v")
@click.pass_context
def cmd(ctx: click.Context, verb: str, params: tuple[str, ...]) -> None:
    from cli.commands.cmd import run
    sys.exit(run(ctx.obj, verb, params))


@cli.command()
@click.argument("x", type=int)
@click.argument("y", type=int)
@click.option("--hold", "hold_ms", default=60, type=int)
@click.pass_context
def touch(ctx: click.Context, x: int, y: int, hold_ms: int) -> None:
    from cli.commands.touch import run
    sys.exit(run(ctx.obj, x, y, hold_ms))


@cli.group()
def audio() -> None:
    pass


@audio.command("record")
@click.option("--duration", "duration_ms", default=1000, type=int)
@click.option("--out", "out_path", required=True)
@click.pass_context
def audio_record(ctx: click.Context, duration_ms: int, out_path: str) -> None:
    from cli.commands.audio import record
    sys.exit(record(ctx.obj, duration_ms, out_path))


@audio.command("play")
@click.option("--in", "in_path", required=True)
@click.pass_context
def audio_play(ctx: click.Context, in_path: str) -> None:
    from cli.commands.audio import play
    sys.exit(play(ctx.obj, in_path))


@audio.command("inject")
@click.option("--in", "in_path", required=True)
@click.pass_context
def audio_inject(ctx: click.Context, in_path: str) -> None:
    from cli.commands.audio import inject
    sys.exit(inject(ctx.obj, in_path))


@cli.command()
@click.option("--batch", "batch_script", default=None)
@click.option("--openocd-config", default=None)
@click.pass_context
def gdb(ctx: click.Context, batch_script: str | None,
        openocd_config: str | None) -> None:
    from cli.commands.gdb import run
    sys.exit(run(ctx.obj, batch_script, openocd_config))


@cli.command()
@click.pass_context
def restart(ctx: click.Context) -> None:
    from cli.commands.restart import run
    sys.exit(run(ctx.obj))


@cli.command()
@click.option("--hil", is_flag=True)
@click.option("--lvgl-sim", "lvgl_sim", is_flag=True)
def setup(hil: bool, lvgl_sim: bool) -> None:
    from cli.commands.setup import run
    sys.exit(run(hil, lvgl_sim))


@cli.group()
def daemon() -> None:
    pass


@daemon.command("start")
@click.option("--port", "port_path", required=True)
@click.option("--idle-seconds", default=600, type=int)
@click.option("--detach", is_flag=True)
def daemon_start(port_path: str, idle_seconds: int, detach: bool) -> None:
    from cli.commands.daemon_cli import start
    sys.exit(start(port_path, idle_seconds, detach))


@daemon.command("stop")
@click.option("--port", "port_path", required=True)
def daemon_stop(port_path: str) -> None:
    from cli.commands.daemon_cli import stop
    sys.exit(stop(port_path))


@daemon.command("status")
def daemon_status() -> None:
    from cli.commands.daemon_cli import status
    sys.exit(status())


@daemon.command("ring")
@click.option("--port", "port_path", required=True)
@click.option("--lines", default=2000, type=int)
@click.option("--filter", "filter_pat", default=None)
def daemon_ring(port_path: str, lines: int, filter_pat: str | None) -> None:
    from cli.commands.daemon_cli import ring
    sys.exit(ring(port_path, lines, filter_pat))


@cli.group()
def ui() -> None:
    pass


@ui.command("dump-tree")
@click.pass_context
def ui_dump_tree(ctx: click.Context) -> None:
    from cli.commands.ui import dump_tree
    sys.exit(dump_tree(ctx.obj))


@cli.command("audit-prod-strip")
@click.pass_context
def audit_prod_strip(ctx: click.Context) -> None:
    from cli.commands.audit_prod_strip import run
    sys.exit(run(ctx.obj))


def _try_register_extensions() -> None:
    """Best-effort: load the cube manifest and register its extensions as
    top-level commands. Failures (missing manifest, parse error, missing
    cli.board module) are silently swallowed — the rest of the CLI still
    works without manifest extensions.

    Force-loads the ``cube`` manifest by name rather than auto-detecting via
    USB scan, so extensions are present in ``--help`` even when no board is
    connected at CLI startup.
    """
    try:
        from cli.board import detect_board
        from cli.commands.extensions import register_dynamic
        manifest = detect_board(boards_dir=BOARDS_DIR, override_name="cube")
    except Exception:
        return
    register_dynamic(cli, manifest)


_try_register_extensions()


if __name__ == "__main__":
    cli(prog_name="esp32-devtool")
