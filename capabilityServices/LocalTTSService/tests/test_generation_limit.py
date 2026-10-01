"""Real engine adapter/executor/WS, deterministic model metadata (no GPU work)."""
import asyncio
import json
from types import SimpleNamespace

import numpy as np
import pytest
from websockets.asyncio.client import connect

from local_tts.config import GenerationConfig
from local_tts.engine import QwenEngine
from .conftest import _make_config, _make_server, _serve, _StubVoiceStore


class Model:
    def __init__(self):
        self.tokenizer = SimpleNamespace(encode=lambda text: list(text))
        self.speech_tokenizer = SimpleNamespace(decoder=SimpleNamespace(
            reset_streaming_state=self.reset))
        self.resets = 0
        self.budgets = []
        self.closed = 0

    def reset(self):
        self.resets += 1

    def generate(self, text, **kwargs):
        budget = kwargs['max_tokens']
        self.budgets.append(budget)
        assert kwargs['split_pattern'] is None
        # Fail short inputs at both exact streaming boundaries and tail chunks.
        tokens = budget if len(text) in (2, 10) else 3
        try:
            while tokens:
                count = min(5, tokens)
                tokens -= count
                yield SimpleNamespace(audio=np.zeros(240, dtype=np.float32),
                                      token_count=count, is_final_chunk=count < 5)
        finally:
            self.closed += 1


@pytest.mark.parametrize('floor', [10, 12])
def test_exhaustion_terminal_and_same_worker_recovery(tmp_path, monkeypatch, floor):
    model = Model()
    monkeypatch.setattr('local_tts.engine._load_model', lambda _: model)
    engine = QwenEngine('stub', generation=GenerationConfig(100, floor, 1))

    async def run():
        server = _make_server(_make_config(tmp_path), engine, _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f'ws://127.0.0.1:{port}/?format=pcm&sample_rate=24000') as ws:
                await ws.recv()
                for text in ('Hi', 'Hello you.', 'Normal sentence.', 'x' * 40, 'x' * 200):
                    await ws.send(json.dumps(dict(type='text', text=text)))
                    await ws.send('{"type":"end"}')
                    async with asyncio.timeout(2):
                        frames = []
                        while True:
                            msg = await ws.recv()
                            if isinstance(msg, bytes):
                                continue
                            evt = json.loads(msg)
                            frames.append(evt['type'])
                            if evt['type'] in ('done', 'error'):
                                break
                    if len(text) in (2, 10):
                        assert frames == ['started', 'error']
                        assert evt['reason'] == f'generation_token_limit: tokens={floor} max_tokens={floor}'
                    else:
                        assert frames == ['started', 'done']
                    # No lingering tail/Done; next request uses same worker/socket.
                    await ws.send('{"type":"ping"}')
                    assert json.loads(await asyncio.wait_for(ws.recv(), 1))['type'] == 'pong'
        finally:
            ws_server.close()
            await ws_server.wait_closed()
            await server.stop()

    asyncio.run(run())
    assert model.budgets[1:] == [floor, floor, 16, 40, 100]
    assert model.closed == model.resets == 6  # warm + five requests


def test_segment_budgets_and_cancel_reset(monkeypatch):
    import threading

    model = Model()
    monkeypatch.setattr('local_tts.engine._load_model', lambda _: model)
    engine = QwenEngine('stub', generation=GenerationConfig(100, 12, 2))
    cancel = threading.Event()
    list(engine.synthesize('abc\n' + 'x' * 80, None, 'auto', 2, cancel))
    assert model.budgets == [12, 100]  # short segment cannot borrow long segment's budget
    stream = engine.synthesize('Hi', None, 'auto', 2, cancel)
    next(stream)
    cancel.set()
    assert list(stream) == []
    assert model.closed == model.resets == 3
    cancel.clear()
    assert len(list(engine.synthesize('normal', None, 'auto', 2, cancel))) == 1
