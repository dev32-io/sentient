"""Manifest-declared board extensions.

Each board manifest may declare an ``extensions:`` list — shell-script bridges
for legacy / pre-device-pairing helpers (e.g. ``bake-creds``) that aren't
worth re-implementing as native Python verbs. Each extension becomes a
top-level click command on the CLI; invoking it execs the manifest's
``exec`` path with all extra args passed through verbatim.

Registration is "best-effort": ``main.py`` calls :func:`register_dynamic`
at startup with the cube manifest force-loaded via ``override_name="cube"``,
so the extension list is available even when no board is on USB at the
moment of CLI invocation. If manifest loading fails for any reason
(missing file, parse error, schema mismatch), registration is silently
skipped — the rest of the CLI still works.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import click

from cli.board import Extension
from cli.repo_root import resolve_repo_root, substitute


def run_extension(ctx_obj: dict, ext: Extension, args: list[str]) -> int:
    """Exec a manifest extension. Returns the child process exit code."""
    if ext.transient:
        click.echo(
            f"[esp32-devtool] {ext.cmd}: transient extension — slated for removal",
            err=True,
        )
    # ``repo_root`` flows through the CLI global flag; fall back to git-root
    # inference if not set. ``substitute`` resolves ``${REPO_ROOT}`` in the
    # manifest's ``exec`` path so manifests stay repo-relocatable.
    override = ctx_obj.get("repo_root") if isinstance(ctx_obj, dict) else None
    repo = Path(override) if override else resolve_repo_root()
    exec_path = substitute(ext.exec, repo_root=repo)
    cmd = [exec_path]
    if ext.args_passthrough:
        cmd.extend(args)
    return subprocess.call(cmd)


def register_dynamic(cli_group: click.Group, manifest) -> None:
    """Register every manifest extension as a top-level command on ``cli_group``.

    Help text comes from the manifest's ``help`` field; falls back to a
    synthesized string when empty.
    """
    for ext in manifest.extensions:
        # Bind ``ext`` per-iteration via a factory so each callback captures
        # its own extension instance (the loop variable would otherwise be
        # shared and every command would dispatch to the last one).
        def make_cb(e: Extension):
            @click.pass_context
            @click.argument("args", nargs=-1, type=click.UNPROCESSED)
            def cb(ctx: click.Context, args: tuple[str, ...]) -> None:
                sys.exit(run_extension(ctx.obj, e, list(args)))

            cb.__name__ = e.cmd.replace("-", "_")
            return cb

        help_text = ext.help.strip() if ext.help else f"Run {ext.cmd} board extension"
        # ``ignore_unknown_options=True`` lets the extension pass through flags
        # like ``--profile debug`` to the underlying shell script verbatim —
        # without this, click swallows any ``--foo`` token before the args
        # tuple sees it and bails with "No such option".
        cli_group.command(
            name=ext.cmd,
            help=help_text,
            context_settings={"ignore_unknown_options": True, "allow_extra_args": True},
        )(make_cb(ext))
