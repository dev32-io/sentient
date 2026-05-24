"""esp32-devtool logs — merged USB ring + UDP relay stream.

Reads two log sources and merges them to stdout:

- USB ring: polls the per-port daemon's in-memory event ring via the
  ``{"kind":"events","n":N}`` protocol (the only stream surface the daemon
  exposes today — no separate subscribe channel).
- UDP relay: a UDP listener on ``manifest.log_relay.port`` (cube firmware
  ships ESP_LOGx lines here via the ``net_logger`` vprintf hook once WiFi is
  up; the future devtool-side relay component re-uses the same port).

Both sources carry the same lines once WiFi is up. We dedupe by short-hash
within a 10 ms bucket so a single ``ESP_LOGI`` doesn't print twice.

Polling cadence + dedupe window are tunables here, not in YAML config — they
control internal CLI behaviour, not device behaviour, and have no operator
knobs.
"""
from __future__ import annotations

import asyncio
import json
import re
import socket
import time
from collections import OrderedDict, deque
from pathlib import Path

import click

from cli.board import BOARDS_DIR, detect_board, resolve_usb_port
from cli.daemon.lifecycle import ensure_daemon, fetch_events, socket_path_for


# Map -level letters to numeric severity. The cube emits ESP_LOGx lines with
# a leading single char ("D (123) tag: msg") so we filter at the host edge.
LEVELS: dict[str, int] = {"D": 0, "I": 1, "W": 2, "E": 3}

# Polling cadence for --follow. 200 ms is well under human-visible delay and
# keeps the daemon load tiny (one events RPC per tick).
_POLL_INTERVAL_S: float = 0.2
# How many tail lines we re-fetch on every poll. The daemon ring is bounded
# (deque maxlen=20000), so a 200-line window is plenty to catch a 1 s burst
# at typical cube log rates (≪ 1000 lines/s).
_POLL_WINDOW: int = 200
# Recent-line hash deque size for dedupe-across-poll. 256 fits multi-second
# bursts without false positives.
_RECENT_LINE_WINDOW: int = 256
# UDP recv buffer per packet. net_logger fragments by line so 8 KiB is more
# than enough.
_UDP_RECV_BUF: int = 8192
# Source-side dedupe (USB ↔ UDP). Bucket size in milliseconds — 10 ms is
# wider than typical USB↔UDP arrival skew but narrow enough that two
# distinct identical lines from a real burst stay separate.
_DEDUPE_BUCKET_MS: int = 10
# Max dedupe keys to retain. Keys evict FIFO once full.
_DEDUPE_MAX_KEYS: int = 4096


class Dedupe:
    """Cross-source dedupe keyed on (time-bucket, source-agnostic, msg-prefix).

    The bucket key spans BOTH sources so the same line arriving on USB and
    UDP within a 10 ms window collapses to one printed entry.
    """

    def __init__(self, max_keys: int = _DEDUPE_MAX_KEYS) -> None:
        self.seen: OrderedDict[tuple, float] = OrderedDict()
        self.max = max_keys

    def saw(self, ts_bucket: int, msg: str) -> bool:
        k = (ts_bucket, msg[:80])
        if k in self.seen:
            return True
        self.seen[k] = time.time()
        if len(self.seen) > self.max:
            self.seen.popitem(last=False)
        return False


def _format_line(source: str, line: str, *, no_color: bool, json_out: bool) -> str:
    ts = time.strftime("%H:%M:%S")
    if json_out:
        return json.dumps({"ts": ts, "source": source, "msg": line})
    return f"[{source} {ts}] {line}"


def _level_passes(line: str, min_level: str) -> bool:
    """Filter ESP_LOGx single-char-prefixed lines by level.

    Boundary markers (``>>> CHECKPOINT``, ``<<< RSP``, etc.) and lines without
    a leading severity char are always passed through — they're not subject
    to level filtering.
    """
    threshold = LEVELS.get(min_level, 1)
    if not line or len(line) < 2 or line[1] != " ":
        return True
    sev = line[0]
    if sev not in LEVELS:
        return True
    return LEVELS[sev] >= threshold


async def _ring_poll_stream(sock_path: Path, initial_lines: int,
                            filter_pat: re.Pattern | None, level: str,
                            follow: bool, queue: asyncio.Queue) -> None:
    """Poll the daemon ring on a fixed cadence.

    Iteration 1 fetches ``initial_lines`` lines. Subsequent iterations fetch
    a ``_POLL_WINDOW`` tail and emit only lines we haven't seen recently
    (hashed into a bounded deque). Exits after one iteration when ``follow``
    is False.
    """
    recent: deque[str] = deque(maxlen=_RECENT_LINE_WINDOW)
    n = initial_lines
    while True:
        lines = await asyncio.get_event_loop().run_in_executor(
            None, fetch_events, sock_path, n
        )
        for raw in lines:
            if raw in recent:
                continue
            recent.append(raw)
            if not _level_passes(raw, level):
                continue
            if filter_pat and not filter_pat.search(raw):
                continue
            await queue.put(("usb", raw))
        if not follow:
            break
        n = _POLL_WINDOW
        await asyncio.sleep(_POLL_INTERVAL_S)


async def _udp_stream(udp_port: int, filter_pat: re.Pattern | None,
                      level: str, queue: asyncio.Queue) -> None:
    """Bind 0.0.0.0:udp_port and forward each datagram as one line."""
    loop = asyncio.get_event_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    sock.bind(("0.0.0.0", udp_port))
    try:
        while True:
            try:
                data, _ = await loop.sock_recvfrom(sock, _UDP_RECV_BUF)
            except OSError:
                break
            text = data.decode("utf-8", errors="replace").rstrip()
            if not text:
                continue
            if not _level_passes(text, level):
                continue
            if filter_pat and not filter_pat.search(text):
                continue
            await queue.put(("udp", text))
    finally:
        sock.close()


async def _merge(queue: asyncio.Queue, *, no_color: bool, json_out: bool,
                 stop_after_idle_s: float | None) -> None:
    """Drain the queue, dedupe across sources, print one line per event.

    When ``stop_after_idle_s`` is set, the merger exits after that many
    seconds of no events arriving. Used to terminate the no-follow path
    after the initial USB drain (UDP source may still be coro-pending).
    """
    dedupe = Dedupe()
    while True:
        if stop_after_idle_s is not None:
            try:
                source, line = await asyncio.wait_for(
                    queue.get(), timeout=stop_after_idle_s
                )
            except asyncio.TimeoutError:
                return
        else:
            source, line = await queue.get()
        bucket = int(time.time() * 1000) // _DEDUPE_BUCKET_MS
        if dedupe.saw(bucket, line):
            continue
        click.echo(_format_line(
            source, line, no_color=no_color, json_out=json_out
        ))


def run(ctx_obj: dict, follow: bool, since: str | None,
        filter_pat: str | None, source: str, level: str,
        no_color: bool, lines: int, json_out: bool) -> int:
    manifest = detect_board(
        boards_dir=BOARDS_DIR,
        override_name=ctx_obj.get("board"),
    )
    port = resolve_usb_port(manifest, ctx_obj.get("port"))
    pat = re.compile(filter_pat) if filter_pat else None

    # `since` is accepted for future filtering on timestamped lines but is
    # not yet implemented. Lines are already strictly ordered within each
    # source, and the daemon ring is bounded — so for now we ignore it.
    _ = since

    queue: asyncio.Queue = asyncio.Queue()

    async def main() -> None:
        producers: list[asyncio.Task] = []
        if source in ("usb", "all"):
            if port is None:
                raise click.ClickException(
                    f"no USB port matched {manifest.usb.port_glob!r}"
                )
            ensure_daemon(port)
            sock_path = socket_path_for(port)
            producers.append(asyncio.create_task(_ring_poll_stream(
                sock_path, lines, pat, level, follow, queue
            )))
        if source in ("udp", "all") and manifest.log_relay.enabled:
            producers.append(asyncio.create_task(_udp_stream(
                manifest.log_relay.port, pat, level, queue
            )))
        if not producers:
            return

        # Non-follow path: producers self-exit after one drain. We wait on
        # them, then drain the queue with a short idle timeout to flush any
        # late UDP arrivals.
        idle_timeout = None if follow else 0.5
        merger = asyncio.create_task(_merge(
            queue, no_color=no_color, json_out=json_out,
            stop_after_idle_s=idle_timeout,
        ))

        if follow:
            try:
                await asyncio.gather(*producers, merger)
            except asyncio.CancelledError:
                pass
            return

        await asyncio.gather(*producers)
        try:
            await asyncio.wait_for(merger, timeout=2.0)
        except asyncio.TimeoutError:
            merger.cancel()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        return 0
    return 0
