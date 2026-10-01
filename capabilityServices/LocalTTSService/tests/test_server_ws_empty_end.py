"""Empty End terminalizes without MLX work; Flush remains reusable and silent."""
import asyncio
import json

import numpy as np
import pytest
from websockets.asyncio.client import connect

from .conftest import _make_config, _make_server, _serve, _StubEngine, _StubVoiceStore


class _AudioEngine(_StubEngine):
    def __init__(self):
        self.calls = 0

    def synthesize(self, *args):
        self.calls += 1
        yield np.ones(240, dtype=np.float32) * 0.1


@pytest.mark.parametrize("text", [None, " \n", "```\ncode\n```", "🎉"])
def test_empty_end_then_normal_speech(tmp_path, text):
    async def run():
        engine = _AudioEngine()
        server = _make_server(_make_config(tmp_path), engine, _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/?format=pcm&sample_rate=24000") as ws:
                await ws.recv()
                # Both truly empty and frontend-filtered Flush remain no-ops.
                for body in (None, text):
                    if body is not None:
                        await ws.send(json.dumps({"type": "text", "text": body}))
                    await ws.send(json.dumps({"type": "flush"}))
                await ws.send(json.dumps({"type": "ping"}))
                assert json.loads(await ws.recv())["type"] == "pong"
                # Empty completion must not wait behind another connection's GPU lock.
                await server._synth_lock.acquire()
                if text is not None:
                    await ws.send(json.dumps({"type": "text", "text": text}))
                await ws.send(json.dumps({"type": "end"}))
                done = json.loads(await asyncio.wait_for(ws.recv(), 1))
                assert done == dict(type="done", requestId=done["requestId"],
                                    ttfa_ms=0, rtf=0, audio_seconds=0)
                assert engine.calls == 0
                server._synth_lock.release()
                # Same socket, no cancel or reconnect required.
                await ws.send(json.dumps({"type": "text", "text": "Hello."}))
                await ws.send(json.dumps({"type": "flush"}))
                await ws.send(json.dumps({"type": "end"}))  # queued empty tail
                started = json.loads(await asyncio.wait_for(ws.recv(), 1))
                assert started["type"] == "started"
                assert isinstance(await asyncio.wait_for(ws.recv(), 1), bytes)
                spoken = json.loads(await asyncio.wait_for(ws.recv(), 1))
                assert spoken["requestId"] == started["requestId"]
                assert spoken["audio_seconds"] > 0
                tail = json.loads(await asyncio.wait_for(ws.recv(), 1))
                assert tail["type"] == "done" and tail["audio_seconds"] == 0
                assert tail["requestId"] != spoken["requestId"]
                assert engine.calls == 1
        finally:
            ws_server.close()
            await ws_server.wait_closed()
            await server.stop()

    asyncio.run(run())
