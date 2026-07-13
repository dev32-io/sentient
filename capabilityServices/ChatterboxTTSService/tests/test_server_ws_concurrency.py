"""Synth-concurrency tests (Task 5 review findings: a deadlock fix + a
previously-untested FSM/invariant).

1. ``test_synthesis_requests_serialize_across_connections`` (WS-level,
   through the full ``Server``) pins the single-shared-``asyncio.Lock``
   invariant ``synthesis.py``'s module docstring (rule 1) documents —
   a keep-worthy FSM/invariant test per ``testing.md``.
2. ``test_close_unblocks_worker_thread_stuck_on_full_queue`` is the
   regression for the disconnect-mid-synthesis deadlock, tested directly
   against ``SynthesisRunner`` (white-box) rather than through the full
   WS stack — see that test's docstring for why.
"""

from __future__ import annotations

import asyncio
import json
import threading

import numpy as np
import pytest
from websockets.asyncio.client import connect

from chatterbox_tts.server import Server
from chatterbox_tts.synth_worker import QUEUE_STOP
from chatterbox_tts.synthesis import _CLOSE_WORKER_TIMEOUT_S, SynthesisRunner

from .conftest import _make_config, _serve, _SENTINEL_CONDS, _StubVoiceStore


class _GatedEngine:
    """Fake engine whose ``synthesize`` blocks on a shared ``threading.Event``
    until released, then yields exactly one small chunk — lets a test hold
    open a synthesis request on demand to observe the shared-lock ordering.
    """

    def __init__(self, gate: threading.Event) -> None:
        self._gate = gate

    def default_conditionals(self) -> object:
        return _SENTINEL_CONDS

    def synthesize(self, text, conds, streaming_interval, cancel):
        self._gate.wait(timeout=5.0)
        yield np.zeros(100, dtype=np.float32)


def test_synthesis_requests_serialize_across_connections(tmp_path):
    """FSM/invariant pin (``testing.md``): the single shared ``asyncio.Lock``
    (``synthesis.py``'s module docstring, rule 1) means two connections'
    synth requests never run concurrently — the second must not even reach
    ``started`` until the first's full drain releases the lock.
    """

    async def run() -> None:
        gate = threading.Event()
        server = Server(_make_config(tmp_path), _GatedEngine(gate), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with (
                connect(f"ws://127.0.0.1:{port}/") as ws_a,
                connect(f"ws://127.0.0.1:{port}/") as ws_b,
            ):
                await ws_a.recv()  # ready
                await ws_b.recv()  # ready

                await ws_a.send(json.dumps({"type": "text", "text": "first"}))
                await ws_a.send(json.dumps({"type": "end"}))
                started_a = json.loads(await asyncio.wait_for(ws_a.recv(), timeout=2.0))
                assert started_a["type"] == "started"

                await ws_b.send(json.dumps({"type": "text", "text": "second"}))
                await ws_b.send(json.dumps({"type": "end"}))

                # B must not start while A holds the shared synth lock.
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(ws_b.recv(), timeout=0.3)

                gate.set()  # release A

                done_a = None
                while done_a is None:
                    frame = await asyncio.wait_for(ws_a.recv(), timeout=2.0)
                    if not isinstance(frame, bytes):
                        parsed = json.loads(frame)
                        if parsed["type"] == "done":
                            done_a = parsed

                # Only now can B proceed.
                started_b = json.loads(await asyncio.wait_for(ws_b.recv(), timeout=2.0))
                assert started_b["type"] == "started"
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())


class _NoopWs:
    """The only WS surface ``SynthesisRunner`` touches outside a real
    request — ``send`` is never actually called by this test (no request
    is driven through ``_handle_one_request``), but the constructor needs
    something with the right shape.
    """

    async def send(self, data: object) -> None:  # pragma: no cover - unused here
        pass


class _NoopLog:
    def log(self, event: str, **fields: object) -> None:
        pass


def test_close_unblocks_worker_thread_stuck_on_full_queue():
    """Regression for the disconnect-mid-synthesis deadlock (Task 5 review
    finding): the old ``close()`` hard-cancelled ``_worker_task``
    unconditionally, which — if a producer thread was already blocked
    inside ``chunk_queue.put()`` because the queue was at its cap — left
    nobody draining, so that ``put()`` (and the thread holding it) hung
    forever.

    Tested directly against ``SynthesisRunner`` (white-box: reaches into
    ``_active_chunk_queue``/``_active_worker_thread``) rather than through
    the full WS stack, deliberately: an earlier version of this test drove
    it end-to-end through a real ``Server``/stub engine and an abrupt
    ``ws.close()``, but the exact race — a producer's ``put()`` already
    in flight against an already-full queue at the instant ``close()``
    runs — turned out to depend on real thread/event-loop scheduling
    order tightly enough that it passed even with the bug reintroduced
    (verified manually). This version manufactures that exact state
    deterministically: pre-fill the queue to its cap, then start a real
    thread blocked on one more ``put()`` — the same cross-thread call
    ``synth_worker.produce_chunks`` makes — before calling ``close()``.
    """

    async def run() -> None:
        loop = asyncio.get_running_loop()
        runner = SynthesisRunner(
            engine=None, voice_store=None, synth_lock=asyncio.Lock(), ws=_NoopWs(),
            conn_id="test-conn", format_="pcm", sample_rate=24000, voice=None,
            streaming_interval=0.5, conn_log=_NoopLog(), metrics_log=_NoopLog(),
        )
        chunk_queue: "asyncio.Queue[object]" = asyncio.Queue(maxsize=2)
        chunk_queue.put_nowait(b"chunk-1")
        chunk_queue.put_nowait(b"chunk-2")  # queue now at its cap

        put_completed = threading.Event()

        def blocked_producer() -> None:
            # Mirrors `synth_worker.produce_chunks`'s cross-thread put:
            # blocks until something drains the queue.
            asyncio.run_coroutine_threadsafe(
                chunk_queue.put(QUEUE_STOP), loop,
            ).result(timeout=_CLOSE_WORKER_TIMEOUT_S + 5.0)
            put_completed.set()

        worker = threading.Thread(
            target=blocked_producer, daemon=True, name="tts-worker-test",
        )
        runner._active_chunk_queue = chunk_queue
        runner._active_worker_thread = worker
        worker.start()

        # Give the thread a beat to actually reach the blocking put(), and
        # confirm it's genuinely stuck (not racing ahead) before testing
        # the recovery path.
        await asyncio.sleep(0.05)
        assert worker.is_alive()
        assert not put_completed.is_set()

        await asyncio.wait_for(runner.close(), timeout=_CLOSE_WORKER_TIMEOUT_S + 2.0)

        assert not worker.is_alive(), "worker thread still stuck on put() after close()"
        assert put_completed.is_set()

    asyncio.run(run())
