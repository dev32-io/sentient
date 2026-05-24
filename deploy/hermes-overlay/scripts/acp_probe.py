"""Standalone ACP test client.

Connects to acp_ws_server.py over WS, exercises every method/notification
the spec relies on, prints results. Used to verify R1-R13 risks in
docs/superpowers/specs/2026-05-07-acp-pivot-design.md §10 before the
gateway-side TS rewrite (Phase 4).

Usage:
  python acp_probe.py --url ws://localhost:8650/acp --token <bearer> \\
                       --profile <user-id> [--scenario {init,new,prompt,list,cancel,all}]

Captures every JSON-RPC notification + response. Save stdout for the
findings doc at docs/research/2026-05-07-acp-probe-results.md.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from contextlib import asynccontextmanager

import aiohttp


class WSClient:
    def __init__(self, ws):
        self._ws = ws
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self.notifications: list[dict] = []
        self._reader_task = asyncio.create_task(self._reader())

    async def _reader(self):
        async for msg in self._ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            doc = json.loads(msg.data)
            if "id" in doc and ("result" in doc or "error" in doc):
                fut = self._pending.pop(doc["id"], None)
                if fut and not fut.done():
                    fut.set_result(doc)
            else:
                self.notifications.append(doc)
                preview = json.dumps(doc, indent=2)[:500]
                print(f"← notif:\n{preview}\n")

    async def request(self, method: str, params: dict | None = None) -> dict:
        rid = self._next_id
        self._next_id += 1
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await self._ws.send_str(
            json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        )
        return await asyncio.wait_for(fut, timeout=120.0)

    async def cancel(self, session_id: str):
        # ACP uses session/cancel (notification) per acp.meta.AGENT_METHODS;
        # LSP-style $/cancelRequest is NOT in the ACP spec.
        await self._ws.send_str(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": {"sessionId": session_id},
                }
            )
        )


@asynccontextmanager
async def connect(url: str, token: str):
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(url, headers={"Authorization": f"Bearer {token}"}) as ws:
            yield WSClient(ws)


async def scenario_initialize(c: WSClient):
    # protocolVersion is required by upstream schema (acp.PROTOCOL_VERSION=1).
    # clientCapabilities.fs/terminal are the documented capability bits;
    # extras are tolerated by the schema for forward-compat.
    res = await c.request(
        "initialize",
        {
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": {"readTextFile": False, "writeTextFile": False},
                "terminal": False,
            },
        },
    )
    print("→ initialize result:")
    print(json.dumps(res, indent=2)[:1000])
    print()
    return res


async def scenario_new(c: WSClient):
    res = await c.request("session/new", {"cwd": "/", "mcpServers": []})
    print("→ session/new result:")
    print(json.dumps(res, indent=2)[:1000])
    print()
    return res.get("result", {}).get("sessionId")


async def scenario_list(c: WSClient):
    res = await c.request("session/list", {})
    print("→ session/list result:")
    print(json.dumps(res, indent=2)[:2000])
    print()
    return res


async def scenario_prompt(c: WSClient, session_id: str, text: str):
    res = await c.request(
        "session/prompt",
        {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": text}],
        },
    )
    print("→ session/prompt result:")
    print(json.dumps(res, indent=2)[:1000])
    print()
    return res


async def scenario_cancel(c: WSClient, session_id: str, text: str):
    task = asyncio.create_task(
        c.request(
            "session/prompt",
            {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}],
            },
        )
    )
    await asyncio.sleep(1.0)
    print(f"→ sending session/cancel for sessionId={session_id}")
    await c.cancel(session_id)
    try:
        res = await asyncio.wait_for(task, timeout=20.0)
        print("→ cancelled prompt result:")
        print(json.dumps(res, indent=2)[:500])
    except asyncio.TimeoutError:
        print("→ cancelled prompt did NOT return within 20s — possible R4 gap")
    except Exception as e:
        print(f"→ cancelled prompt errored: {type(e).__name__}: {e}")
    print()


async def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://localhost:8650/acp")
    p.add_argument("--token", default="test-token")
    p.add_argument("--profile", required=True)
    p.add_argument(
        "--scenario",
        default="all",
        choices=["init", "new", "prompt", "list", "cancel", "all"],
    )
    args = p.parse_args()

    print(f"=== ACP probe — profile={args.profile} url={args.url} scenario={args.scenario} ===\n")

    async with connect(args.url, args.token) as c:
        await scenario_initialize(c)

        sid = None
        if args.scenario in ("new", "all", "prompt", "cancel"):
            sid = await scenario_new(c)

        if args.scenario in ("list", "all"):
            await scenario_list(c)

        if args.scenario in ("prompt", "all") and sid:
            await scenario_prompt(c, sid, "Say hi in 5 words.")

        if args.scenario in ("cancel", "all") and sid:
            await scenario_cancel(c, sid, "Write a long story about a cat.")

        # Wait briefly to flush trailing notifications (auto-title etc.)
        print("Waiting 15s for trailing notifications...")
        await asyncio.sleep(15.0)

        print(f"\n--- captured {len(c.notifications)} notifications ---")
        for n in c.notifications:
            print(json.dumps(n, indent=2)[:500])
            print()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
