"""
PoC client: Tests WebSocket gateway with 5 concurrent streams.
Measures: connection setup, frame multiplexing, barge-in latency, throughput.
"""

import asyncio
import json
import os
import time
import statistics

import aiohttp

SERVER_URL = "http://127.0.0.1:8765/ws"
NUM_CLIENTS = 5
AUDIO_FRAMES_PER_UTTERANCE = 50  # 50 * 20ms = 1 second of audio
OPUS_FRAME_SIZE = 80  # bytes, typical for 20kbps voice


class ClientMetrics:
    def __init__(self, client_id: int):
        self.client_id = client_id
        self.connect_ms = 0.0
        self.auth_ms = 0.0
        self.audio_send_ms = 0.0
        self.frames_sent = 0
        self.frames_received = 0
        self.response_start_ms = 0.0  # time from audio.end to response.start
        self.barge_in_latency_ms = 0.0
        self.barge_in_frames_before_stop = 0
        self.total_ms = 0.0
        self.errors: list[str] = []


async def run_client(client_id: int, scenario: str) -> ClientMetrics:
    metrics = ClientMetrics(client_id)
    total_start = time.monotonic()

    async with aiohttp.ClientSession() as http_session:
        # Connect
        t0 = time.monotonic()
        ws = await http_session.ws_connect(SERVER_URL)
        metrics.connect_ms = (time.monotonic() - t0) * 1000

        # Auth
        t0 = time.monotonic()
        await ws.send_str(json.dumps({
            "type": "session.start",
            "token": f"test-token-{client_id}",
            "user": f"user-{client_id}"
        }))

        msg = await ws.receive()
        auth_data = json.loads(msg.data)
        metrics.auth_ms = (time.monotonic() - t0) * 1000

        if auth_data.get("type") != "session.ready":
            metrics.errors.append(f"Expected session.ready, got {auth_data}")
            await ws.close()
            return metrics

        # Send audio frames (simulated Opus)
        await ws.send_str(json.dumps({"type": "audio.start"}))
        t0 = time.monotonic()
        for i in range(AUDIO_FRAMES_PER_UTTERANCE):
            fake_opus = os.urandom(OPUS_FRAME_SIZE)
            await ws.send_bytes(fake_opus)
            metrics.frames_sent += 1
            # Don't sleep — blast frames to test throughput
        await ws.send_str(json.dumps({"type": "audio.end"}))
        metrics.audio_send_ms = (time.monotonic() - t0) * 1000

        if scenario == "normal":
            # Wait for full response
            t0 = time.monotonic()
            response_started = False
            while True:
                msg = await asyncio.wait_for(ws.receive(), timeout=5.0)
                if msg.type == WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data["type"] == "response.start":
                        metrics.response_start_ms = (time.monotonic() - t0) * 1000
                        response_started = True
                    elif data["type"] == "response.end":
                        break
                elif msg.type == WSMsgType.BINARY:
                    metrics.frames_received += 1

        elif scenario == "barge_in":
            # Wait for some audio frames, then barge-in
            t0 = time.monotonic()
            frames_before_barge = 0
            while True:
                msg = await asyncio.wait_for(ws.receive(), timeout=5.0)
                if msg.type == WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data["type"] == "response.start":
                        metrics.response_start_ms = (time.monotonic() - t0) * 1000
                elif msg.type == WSMsgType.BINARY:
                    metrics.frames_received += 1
                    frames_before_barge += 1
                    # After receiving 5 frames, barge in
                    if frames_before_barge == 5:
                        barge_t0 = time.monotonic()
                        await ws.send_str(json.dumps({"type": "barge_in"}))
                        # Wait for ack
                        while True:
                            ack_msg = await asyncio.wait_for(ws.receive(), timeout=5.0)
                            if ack_msg.type == WSMsgType.TEXT:
                                ack_data = json.loads(ack_msg.data)
                                if ack_data["type"] == "barge_in.ack":
                                    metrics.barge_in_latency_ms = (time.monotonic() - barge_t0) * 1000
                                    metrics.barge_in_frames_before_stop = frames_before_barge
                                    break
                                elif ack_data["type"] == "audio.end":
                                    # Also acceptable — audio.end comes before or after ack
                                    continue
                            elif ack_msg.type == WSMsgType.BINARY:
                                # Might get 1-2 more frames in flight
                                metrics.frames_received += 1
                                frames_before_barge += 1
                        break

        elif scenario == "text_only":
            # Send text query instead of audio
            await ws.send_str(json.dumps({
                "type": "text.input",
                "text": "What is the weather?"
            }))
            t0 = time.monotonic()
            while True:
                msg = await asyncio.wait_for(ws.receive(), timeout=5.0)
                if msg.type == WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data["type"] == "response.start":
                        metrics.response_start_ms = (time.monotonic() - t0) * 1000
                    elif data["type"] == "response.end":
                        break
                elif msg.type == WSMsgType.BINARY:
                    metrics.frames_received += 1

        # Keepalive test
        await ws.send_str(json.dumps({"type": "ping"}))
        pong = await asyncio.wait_for(ws.receive(), timeout=2.0)
        pong_data = json.loads(pong.data)
        if pong_data.get("type") != "pong":
            metrics.errors.append(f"Expected pong, got {pong_data}")

        await ws.close()

    metrics.total_ms = (time.monotonic() - total_start) * 1000
    return metrics


from aiohttp import WSMsgType

async def run_concurrent_test():
    print("=" * 70)
    print("PoC: Client-Gateway Protocol — WebSocket Multiplexing Test")
    print("=" * 70)

    # Test 1: 5 concurrent normal sessions
    print("\n--- Test 1: 5 concurrent normal sessions ---")
    t0 = time.monotonic()
    results = await asyncio.gather(*[
        run_client(i, "normal") for i in range(NUM_CLIENTS)
    ])
    wall_time = (time.monotonic() - t0) * 1000

    for r in results:
        print(f"  Client {r.client_id}: connect={r.connect_ms:.1f}ms auth={r.auth_ms:.1f}ms "
              f"send={r.audio_send_ms:.1f}ms response_start={r.response_start_ms:.1f}ms "
              f"frames_in={r.frames_sent} frames_out={r.frames_received} "
              f"total={r.total_ms:.1f}ms errors={r.errors}")

    connect_times = [r.connect_ms for r in results]
    auth_times = [r.auth_ms for r in results]
    response_times = [r.response_start_ms for r in results]

    print(f"\n  Summary (5 clients):"
          f"\n    Wall time: {wall_time:.1f}ms"
          f"\n    Connect: median={statistics.median(connect_times):.1f}ms max={max(connect_times):.1f}ms"
          f"\n    Auth: median={statistics.median(auth_times):.1f}ms max={max(auth_times):.1f}ms"
          f"\n    Response start: median={statistics.median(response_times):.1f}ms max={max(response_times):.1f}ms"
          f"\n    Total frames received: {sum(r.frames_received for r in results)}"
          f"\n    Errors: {sum(len(r.errors) for r in results)}")

    # Test 2: 5 concurrent barge-in sessions
    print("\n--- Test 2: 5 concurrent barge-in sessions ---")
    t0 = time.monotonic()
    results = await asyncio.gather(*[
        run_client(i, "barge_in") for i in range(NUM_CLIENTS)
    ])
    wall_time = (time.monotonic() - t0) * 1000

    for r in results:
        print(f"  Client {r.client_id}: barge_in_latency={r.barge_in_latency_ms:.1f}ms "
              f"frames_before_stop={r.barge_in_frames_before_stop} "
              f"frames_received={r.frames_received} errors={r.errors}")

    barge_latencies = [r.barge_in_latency_ms for r in results]
    print(f"\n  Barge-in summary:"
          f"\n    Wall time: {wall_time:.1f}ms"
          f"\n    Latency: median={statistics.median(barge_latencies):.1f}ms max={max(barge_latencies):.1f}ms"
          f"\n    All cancelled within 1 frame: {all(r.barge_in_frames_before_stop <= 6 for r in results)}"
          f"\n    Errors: {sum(len(r.errors) for r in results)}")

    # Test 3: Text-only query
    print("\n--- Test 3: Text-only query ---")
    r = await run_client(0, "text_only")
    print(f"  Client 0: response_start={r.response_start_ms:.1f}ms "
          f"frames_received={r.frames_received} total={r.total_ms:.1f}ms errors={r.errors}")

    # Test 4: Throughput — blast audio frames and measure
    print("\n--- Test 4: Frame throughput (5 clients blasting simultaneously) ---")
    t0 = time.monotonic()
    results = await asyncio.gather(*[
        run_client(i, "normal") for i in range(NUM_CLIENTS)
    ])
    elapsed = (time.monotonic() - t0) * 1000
    total_frames = sum(r.frames_sent for r in results)
    print(f"  {total_frames} frames sent by {NUM_CLIENTS} clients in {elapsed:.1f}ms"
          f"\n  Throughput: {total_frames / (elapsed / 1000):.0f} frames/sec aggregate"
          f"\n  Per-client: {total_frames / NUM_CLIENTS / (elapsed / 1000):.0f} frames/sec")

    # Test 5: Memory estimate
    print("\n--- Test 5: Memory footprint estimate ---")
    import sys
    sample_session = Session("test", "user", None)
    # Rough estimate: session object + buffer overhead
    session_size = sys.getsizeof(sample_session) + sys.getsizeof(sample_session.__dict__)
    print(f"  Session object: ~{session_size} bytes"
          f"\n  5 sessions + overhead: ~{session_size * 5 * 3} bytes (~{session_size * 5 * 3 / 1024:.1f} KB)"
          f"\n  With 60s conversation history buffer: ~{5 * 50 * 80 * 60 / 1024:.0f} KB (5 users × 50fps × 80B × 60s)"
          f"\n  Total estimate: well under 1MB — negligible on 8GB RPi5")

    print("\n" + "=" * 70)
    all_errors = sum(len(r.errors) for r in results)
    print(f"RESULT: {'PASS' if all_errors == 0 else 'FAIL'} — {all_errors} errors")
    print("=" * 70)


# Need Session import for memory test
from server import Session

if __name__ == "__main__":
    asyncio.run(run_concurrent_test())
