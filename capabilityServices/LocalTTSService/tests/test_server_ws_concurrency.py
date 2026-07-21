"""Synth-concurrency tests (Task 5 review findings: a deadlock fix + a
previously-untested FSM/invariant + a fix-pass-3 teardown regression).

1. ``test_synthesis_requests_serialize_across_connections`` (WS-level,
   through the full ``Server``) pins the single-shared-``asyncio.Lock``
   invariant ``synthesis.py``'s module docstring (rule 1) documents —
   a keep-worthy FSM/invariant test per ``testing.md``.
2. ``test_close_unblocks_worker_thread_stuck_on_full_queue`` is the
   regression for the disconnect-mid-synthesis deadlock, tested directly
   against ``SynthesisRunner`` (white-box) rather than through the full
   WS stack — see that test's docstring for why.
3. ``test_close_blocks_second_queued_request_from_starting`` is the
   regression for the fix-pass-3 finding: ``close()`` must stop a
   SECOND, already-queued request from starting once teardown begins,
   not just cancel the first in-flight one — see that test's docstring.
"""

from __future__ import annotations

import asyncio
import json
import threading

import numpy as np
import pytest
from websockets.asyncio.client import connect

from local_tts.synth_executor import SynthExecutor, SynthJob
from local_tts.synth_worker import QUEUE_STOP
from local_tts.synthesis import _CLOSE_WORKER_TIMEOUT_S, SynthesisRunner
from local_tts.text_frontend import build_frontend

from .conftest import _make_config, _make_server, _serve, _StubVoiceStore


class _GatedEngine:
    """Fake engine whose ``synthesize`` blocks on a shared ``threading.Event``
    until released, then yields exactly one small chunk — lets a test hold
    open a synthesis request on demand to observe the shared-lock ordering.
    """

    def __init__(self, gate: threading.Event) -> None:
        self._gate = gate

    def warm(self) -> None:
        pass

    def synthesize(self, text, ref_audio_path, lang_code, streaming_interval, cancel):
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
        server = _make_server(_make_config(tmp_path), _GatedEngine(gate), _StubVoiceStore())
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
    ``_active_chunk_queue``/``_active_job``) rather than through the full WS
    stack, deliberately: an earlier version of this test drove it
    end-to-end through a real ``Server``/stub engine and an abrupt
    ``ws.close()``, but the exact race — a producer's ``put()`` already
    in flight against an already-full queue at the instant ``close()``
    runs — turned out to depend on real thread/event-loop scheduling
    order tightly enough that it passed even with the bug reintroduced
    (verified manually). This version manufactures that exact state
    deterministically: pre-fill the queue to its cap, then start a real
    thread blocked on one more ``put()`` — the same cross-thread call the
    MLX thread makes in ``synth_worker.produce_chunks`` — with the job's
    ``done`` set only after that put finally completes (exactly as the
    executor sets it once ``produce_chunks`` returns), before ``close()``.
    """

    async def run() -> None:
        loop = asyncio.get_running_loop()
        runner = SynthesisRunner(
            executor=None, voice_store=None, synth_lock=asyncio.Lock(), ws=_NoopWs(),
            conn_id="test-conn", format_="pcm", sample_rate=24000, voice=None,
            streaming_interval=0.5, default_lang="auto", conn_log=_NoopLog(), metrics_log=_NoopLog(),
            frontend=build_frontend(normalize_enabled=False),
        )
        chunk_queue: "asyncio.Queue[object]" = asyncio.Queue(maxsize=2)
        chunk_queue.put_nowait(b"chunk-1")
        chunk_queue.put_nowait(b"chunk-2")  # queue now at its cap

        job = SynthJob(
            text="", ref_audio_path=None, lang_code="auto", streaming_interval=0.5,
            cancel_event=threading.Event(), encoder=None, counter=None,
            loop=loop, chunk_queue=chunk_queue, done=threading.Event(),
        )
        put_completed = threading.Event()

        def blocked_producer() -> None:
            # Mirrors the MLX thread's blocking cross-thread put; the executor
            # sets `job.done` once `produce_chunks` returns — modelled here by
            # setting it right after the (finally-unblocked) put completes.
            asyncio.run_coroutine_threadsafe(
                chunk_queue.put(QUEUE_STOP), loop,
            ).result(timeout=_CLOSE_WORKER_TIMEOUT_S + 5.0)
            put_completed.set()
            job.done.set()

        worker = threading.Thread(
            target=blocked_producer, daemon=True, name="tts-mlx-worker-test",
        )
        runner._active_chunk_queue = chunk_queue
        runner._active_job = job
        worker.start()

        # Give the thread a beat to actually reach the blocking put(), and
        # confirm it's genuinely stuck (not racing ahead) before testing
        # the recovery path.
        await asyncio.sleep(0.05)
        assert worker.is_alive()
        assert not put_completed.is_set()
        assert not job.done.is_set()

        await asyncio.wait_for(runner.close(), timeout=_CLOSE_WORKER_TIMEOUT_S + 2.0)

        assert not worker.is_alive(), "producer still stuck on put() after close()"
        assert put_completed.is_set()
        assert job.done.is_set()

    asyncio.run(run())


class _CancelAwareEngine:
    """Fake engine that blocks in ``synthesize()`` until ``cancel_event`` is
    set, then returns with zero chunks — mirrors ``synthesize()`` checking
    ``cancel`` between chunks in production (``synthesis.py``'s module
    docstring, rule 3), which is exactly what lets ``close()``'s own
    ``cancel_event.set()`` unblock an in-flight request unassisted.

    ``started`` is set the moment ``synthesize()`` is entered — the test's
    deterministic (event-gated) signal that request 1 is genuinely
    in-flight before it enqueues request 2 and calls ``close()``.
    ``start_count`` tallies how many times ``synthesize()`` is entered, so
    the test can assert the second (queued) request never starts one.
    """

    def __init__(self, started: threading.Event) -> None:
        self._started = started
        self.start_count = 0
        self._lock = threading.Lock()

    def warm(self) -> None:
        pass

    def synthesize(self, text, ref_audio_path, lang_code, streaming_interval, cancel):
        with self._lock:
            self.start_count += 1
        self._started.set()
        while not cancel.is_set():
            cancel.wait(timeout=0.01)
        return
        yield  # pragma: no cover - unreachable; keeps this a generator function


def test_close_blocks_second_queued_request_from_starting():
    """Regression for the fix-pass-3 review finding: the old ``close()``
    snapshotted ``_active_worker_thread``/``cancel_event`` ONCE, but
    ``_run_queue`` could dequeue + start the NEXT queued request during
    ``close()``'s poll window (once the first finished cancelling) —
    reassigning ``_active_worker_thread`` to a fresh, un-cancelled worker
    that ``close()`` never waits for or cancels, leaving it to run to
    completion while holding the shared synth lock. Fixed by a
    ``self._closing`` flag set (and the pending queue drained) FIRST, and
    checked by ``_run_queue`` before it will start any further request.

    Reproduces the real race through the actual ``_run_queue`` background
    task (not a manually-wired stand-in): request 1 is driven genuinely
    in-flight with a real worker thread; request 2 is queued on the same
    connection exactly as ``ConnectionSession._route`` would (``add_text``
    + ``flush``) while request 1 is still running; ``close()`` is invoked
    concurrently. Deterministic throughout — synchronized on
    ``threading.Event``s and ``asyncio.wait_for`` bounds, no fixed sleeps
    used as the sync mechanism.
    """

    async def run() -> None:
        started = threading.Event()
        engine = _CancelAwareEngine(started)
        executor = SynthExecutor(engine)
        executor.start_and_warm()
        runner = SynthesisRunner(
            executor=executor, voice_store=_StubVoiceStore(), synth_lock=asyncio.Lock(),
            ws=_NoopWs(), conn_id="test-conn-2", format_="pcm", sample_rate=24000,
            voice=None, streaming_interval=0.5, default_lang="auto",
            conn_log=_NoopLog(), metrics_log=_NoopLog(),
            frontend=build_frontend(normalize_enabled=False),
        )

        runner.add_text("first")
        runner.flush()  # request 1 onto this connection's request queue

        # Deterministic: block until request 1 has actually entered
        # `synthesize()` on the MLX thread — it is now genuinely in-flight.
        await asyncio.to_thread(started.wait, 2.0)
        assert started.is_set(), "request 1 never started"
        job_1 = runner._active_job
        assert job_1 is not None and not job_1.done.is_set()

        # Request 2 lands on the SAME connection's queue while request 1 is
        # still running — the exact pre-condition the bug hits: a second,
        # already-queued-but-unstarted request present when close() begins.
        runner.add_text("second")
        runner.flush()
        assert runner._queue.qsize() == 1

        await asyncio.wait_for(runner.close(), timeout=_CLOSE_WORKER_TIMEOUT_S + 2.0)

        # (a) the second (queued) request never started a synthesis.
        assert engine.start_count == 1, "second queued request must not start during/after teardown"
        assert runner._active_job is job_1, "no second job was ever assigned"
        assert runner._queue.empty(), "queued-but-unstarted request must be dropped, not deferred"
        # (b) request 1's job finished (cancelled) by the time close() returns.
        assert job_1.done.is_set(), "request 1's job still unfinished after close()"
        assert runner._closing is True
        executor.shutdown()

    asyncio.run(run())
