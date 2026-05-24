"""
PoC: WebSocket voice gateway server
Validates: frame multiplexing, barge-in, 5 concurrent streams, session management
"""

import asyncio
import json
import os
import time
import traceback
from aiohttp import web, WSMsgType

# --- Session management ---

class Session:
    def __init__(self, session_id: str, user: str, ws: web.WebSocketResponse):
        self.session_id = session_id
        self.user = user
        self.ws = ws
        self.created_at = time.monotonic()
        self.audio_frames_received = 0
        self.audio_frames_sent = 0
        self.is_responding = False
        self._cancel_event = asyncio.Event()
        self._response_task: asyncio.Task | None = None

    async def interrupt(self):
        """Barge-in: cancel any in-flight response."""
        self._cancel_event.set()
        if self._response_task and not self._response_task.done():
            self._response_task.cancel()
            try:
                await self._response_task
            except asyncio.CancelledError:
                pass
        self.is_responding = False
        self._cancel_event.clear()

    @property
    def cancelled(self):
        return self._cancel_event.is_set()


sessions: dict[str, Session] = {}

# --- Simulated pipeline ---

async def simulate_pipeline_response(session: Session):
    """
    Simulates: STT → Classifier → LLM → TTS pipeline.
    Sends back simulated Opus audio frames with streaming overlap.
    """
    session.is_responding = True
    try:
        # Simulate STT + classifier latency
        await asyncio.sleep(0.05)  # 50ms (compressed for PoC)

        # Send response.start
        await session.ws.send_str(json.dumps({"type": "response.start"}))

        # Simulate LLM streaming + TTS overlap
        # Send 20 audio frames (20ms each = 400ms of audio) to simulate a short response
        await session.ws.send_str(json.dumps({"type": "audio.start"}))

        for i in range(20):
            if session.cancelled:
                break

            # Simulate Opus frame: 80 bytes of audio data (typical for 20kbps voice)
            fake_opus_frame = os.urandom(80)
            await session.ws.send_bytes(fake_opus_frame)
            session.audio_frames_sent += 1

            # 20ms frame pacing (simulates real-time audio delivery)
            await asyncio.sleep(0.02)

        await session.ws.send_str(json.dumps({"type": "audio.end"}))
        await session.ws.send_str(json.dumps({"type": "response.end"}))

    except asyncio.CancelledError:
        # Barge-in happened — send audio.end to signal client to stop playback
        try:
            await session.ws.send_str(json.dumps({"type": "audio.end", "reason": "interrupted"}))
        except Exception:
            pass
        raise
    finally:
        session.is_responding = False


# --- WebSocket handler ---

_session_counter = 0

async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    global _session_counter
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    session: Session | None = None

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                data = json.loads(msg.data)
                msg_type = data.get("type")

                if msg_type == "session.start":
                    token = data.get("token", "")
                    # Simplified auth: accept any token, extract user from it
                    user = data.get("user", f"user-{_session_counter}")
                    _session_counter += 1
                    session_id = f"sess-{_session_counter}-{int(time.time())}"
                    session = Session(session_id, user, ws)
                    sessions[session_id] = session

                    await ws.send_str(json.dumps({
                        "type": "session.ready",
                        "session_id": session_id,
                        "user": user
                    }))

                elif msg_type == "audio.end" and session:
                    # End of user utterance — trigger pipeline
                    session._response_task = asyncio.create_task(
                        simulate_pipeline_response(session)
                    )

                elif msg_type == "barge_in" and session:
                    # Cancel current response
                    barge_in_start = time.monotonic()
                    await session.interrupt()
                    barge_in_ms = (time.monotonic() - barge_in_start) * 1000
                    await ws.send_str(json.dumps({
                        "type": "barge_in.ack",
                        "cancel_latency_ms": round(barge_in_ms, 2)
                    }))

                elif msg_type == "text.input" and session:
                    # Text query — trigger pipeline directly
                    session._response_task = asyncio.create_task(
                        simulate_pipeline_response(session)
                    )

                elif msg_type == "ping":
                    await ws.send_str(json.dumps({"type": "pong"}))

            elif msg.type == WSMsgType.BINARY:
                # Audio frame received
                if session:
                    session.audio_frames_received += 1

            elif msg.type == WSMsgType.ERROR:
                print(f"WebSocket error: {ws.exception()}")

    except Exception as e:
        print(f"Handler error: {e}")
        traceback.print_exc()
    finally:
        if session:
            # Clean up session
            sessions.pop(session.session_id, None)

    return ws


async def health_handler(request: web.Request) -> web.Response:
    return web.json_response({
        "status": "ok",
        "active_sessions": len(sessions),
        "sessions": {
            sid: {
                "user": s.user,
                "audio_in": s.audio_frames_received,
                "audio_out": s.audio_frames_sent,
                "responding": s.is_responding
            }
            for sid, s in sessions.items()
        }
    })


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/ws", websocket_handler)
    app.router.add_get("/health", health_handler)
    return app


if __name__ == "__main__":
    app = create_app()
    web.run_app(app, host="127.0.0.1", port=8765, print=lambda msg: print(msg))
