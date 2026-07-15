"""Regression pin for the MLX thread-affinity fix (``synth_executor.py``).

MLX (>= 0.31.2) binds each array's GPU-stream affinity to the thread that
allocated it; evaluating on another thread raises ``There is no
Stream(gpu, N) in current thread``. The prior service span a fresh thread
per synthesis request while the model was warmed on the startup thread, so
weight arrays and ``mx.eval`` lived on different threads — an intermittent
crash that broke live TTS after a few requests (see the module docstring).

The invariant that fixes it: **warm() and every synthesize() run on the
ONE dedicated executor thread** — never the caller/event-loop thread, and
always the same thread across many jobs. This test pins exactly that,
deterministically and with no MLX: a fake engine records the thread ident
of each call. It is the coverage gap that let the bug ship — the ``@live``
engine tests call ``synthesize()`` directly on the test thread, never
through the worker hand-off the real service uses.
"""

from __future__ import annotations

import asyncio
import threading

import numpy as np

from local_tts.encoders import make_encoder
from local_tts.synth_executor import SynthExecutor, SynthJob
from local_tts.synth_worker import QUEUE_STOP, SampleCounter

_JOBS = 4


class _ThreadRecordingEngine:
    """Fake engine that records which thread ``warm``/``synthesize`` run on."""

    def __init__(self) -> None:
        self.warm_thread: int | None = None
        self.synth_threads: list[int] = []

    def warm(self) -> None:
        self.warm_thread = threading.get_ident()

    def synthesize(self, text, ref_audio_path, lang_code, streaming_interval, cancel):
        self.synth_threads.append(threading.get_ident())
        yield np.zeros(240, dtype=np.float32)


async def _drain(chunk_queue: "asyncio.Queue") -> None:
    while True:
        if await chunk_queue.get() is QUEUE_STOP:
            return


def test_warm_and_all_synthesis_run_on_one_dedicated_thread():
    async def run() -> None:
        loop = asyncio.get_running_loop()
        caller_thread = threading.get_ident()
        engine = _ThreadRecordingEngine()
        executor = SynthExecutor(engine)
        executor.start_and_warm()

        for _ in range(_JOBS):
            chunk_queue: "asyncio.Queue" = asyncio.Queue()
            job = SynthJob(
                text="hi", ref_audio_path=None, lang_code="auto", streaming_interval=0.5,
                cancel_event=threading.Event(), encoder=make_encoder("pcm", 24000),
                counter=SampleCounter(), loop=loop, chunk_queue=chunk_queue,
                done=threading.Event(),
            )
            executor.submit(job)
            await _drain(chunk_queue)
            await asyncio.to_thread(job.done.wait, 2.0)
            assert job.done.is_set()

        executor.shutdown()

        # Warm ran on the executor thread, NOT the caller/event-loop thread.
        assert engine.warm_thread is not None
        assert engine.warm_thread != caller_thread
        # Every synthesis ran on that SAME single thread — the whole point.
        assert engine.synth_threads == [engine.warm_thread] * _JOBS

    asyncio.run(run())
