"""Pins the Task 6 wiring: ``SynthesisRunner.flush()`` must run the buffered
text through the injected ``frontend`` before enqueueing, and must skip the
enqueue entirely when the frontend reduces the text to nothing (e.g. a
fenced code block with no speakable content) — see ``synthesis.py``'s
``flush()`` docstring.
"""

import asyncio

from local_tts.text_frontend import SpeechPolicy, build_frontend


class _FakeFrontend:
    def __init__(self):
        self.calls = []

    def process(self, doc, lang):
        self.calls.append((doc, lang))
        return f"NORM::{doc}"


class _FakeVoiceStore:
    """No voice pinned in these tests -- always defers to ``default_lang``."""

    def language_of(self, voice_id) -> str:
        return ""


class _ZhVoiceStore:
    """A pack that declares zh, so the pack -- not default_lang -- decides."""

    def language_of(self, voice_id) -> str:
        return "zh"


def _make_runner(frontend, voice_store=None):
    # Import here so the test file loads even if heavy deps shift.
    from local_tts.synthesis import SynthesisRunner
    return SynthesisRunner(
        executor=None, voice_store=voice_store or _FakeVoiceStore(),
        synth_lock=asyncio.Lock(), ws=None,
        conn_id="t", format_="opus", sample_rate=48000, voice=None,
        streaming_interval=0.5, default_lang="en", conn_log=_NullLog(),
        metrics_log=_NullLog(), frontend=frontend,
    )


def test_voice_pack_language_overrides_default_lang():
    # The pack's language is the declared tiebreak for genuinely mixed text.
    # Only the empty-pack fallback was covered before, so a regression that
    # ignored the pack entirely would have gone unnoticed.
    fe = _FakeFrontend()

    async def run():
        runner = _make_runner(fe, voice_store=_ZhVoiceStore())
        runner._worker_task.cancel()
        runner.add_text("hello")
        runner.flush()
        assert fe.calls == [("hello", "zh")]  # zh from the pack, not "en"

    asyncio.run(run())


class _NullLog:
    def log(self, *a, **k): ...


def test_flush_runs_frontend_before_enqueue():
    fe = _FakeFrontend()

    async def run():
        runner = _make_runner(fe)
        runner._worker_task.cancel()  # don't actually synthesize
        runner.add_text("It costs $50")
        runner.flush()
        assert fe.calls == [("It costs $50", "en")]
        assert runner._queue.get_nowait() == "NORM::It costs $50"

    asyncio.run(run())


def test_flush_skips_enqueue_when_frontend_returns_empty():
    fe = build_frontend(
        normalize_enabled=True,
        normalize_languages=("en", "zh", "ja"),
        policy=SpeechPolicy(table_max_cells=24, code_span_max_chars=32, speak_dropped_spans=True),
        script_confidence=0.9,
    )

    async def run():
        runner = _make_runner(fe)
        runner._worker_task.cancel()
        runner.add_text("```\njust code\n```")
        runner.flush()
        assert runner._queue.empty()

    asyncio.run(run())


def test_cancel_drops_queued_empty_end_and_close_fences_worker():
    import json

    class Socket:
        def __init__(self):
            self.frames = []

        async def send(self, frame):
            self.frames.append(json.loads(frame))

    async def run():
        runner = _make_runner(_FakeFrontend())
        ws = Socket()
        runner._ws = ws
        # Real frontend ensures empty input stays empty.
        runner._frontend = build_frontend(
            normalize_enabled=False, normalize_languages=(),
            policy=SpeechPolicy(table_max_cells=24, code_span_max_chars=32,
                                speak_dropped_spans=True), script_confidence=0.9,
        )
        runner.flush(end=True)
        runner.cancel_current()
        await asyncio.sleep(0)
        assert ws.frames == []
        runner.flush(end=True)
        await asyncio.sleep(0)
        assert [f["type"] for f in ws.frames] == ["done"]
        runner.flush(end=True)
        await runner.close()
        assert len(ws.frames) == 1

    asyncio.run(run())
