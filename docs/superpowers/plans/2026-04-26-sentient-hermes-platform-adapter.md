# Sentient Hermes Platform Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot Sentient's Hermes integration from `/v1/responses` + per-user docker reconciler to a custom Hermes platform adapter (`sentient_gateway`), one supervisord-managed `hermes -p <userId> gateway run` process per active user inside a single overlay container, and a WS-based IPC contract between the Bun gateway and the embedded Python adapter.

**Architecture:** `deploy/hermes-overlay/` builds an image `FROM nousresearch/hermes-agent:${HERMES_VERSION}`, drops in `sentient_gateway.py` (subclass of `BasePlatformAdapter`), applies 5 surgical patches, and runs supervisord. Bun gateway maintains N WS connections, routes by userId, keeps all voice/STT/TTS/barge-in. Self-service per-user SOUL.md and `agent.personalities` editing in the webui with a "save → restart that user's agent (5–10s spinner) → reconnect" UX.

**Tech Stack:**
- Python 3.13 + aiohttp (adapter, lives inside Hermes process)
- Bun + TypeScript strict (gateway), Vitest, Zod
- Preact + TypeScript strict (webui)
- supervisord 4.x (per-profile process supervision)
- Docker compose

**Spec:** `docs/superpowers/specs/2026-04-26-sentient-hermes-platform-adapter-design.md` — read end to end before any code.

**Branch:** `feature/sentient-hermes-platform-adapter` off `develop` (Task 0 sets up).

**Upstream pin:** `nousresearch/hermes-agent:v2026.4.16` (see `deploy/hermes-overlay/HERMES_VERSION`). Source for grounding lives at `/tmp/hermes-agent` from the brainstorming session — clone fresh via Task 0 if absent.

---

## Hard Rules (apply to every task)

1. **No `--no-verify` ever.** Lint, typecheck, all tests stay green per commit. Pre-existing hook failures get a one-line `biome-ignore` with rule + reason.
2. **Test-lean doctrine** (`.claude/rules/testing.md`). Tests pin (1) wire/protocol contract, (2) FSM/invariant, (3) security boundary, or (4) `@live`/browser smoke. No factory-wiring tests, no per-component render tests. Manual browser smoke is the primary regression net for UX.
3. **Files <300 lines, functions <40 lines, nesting ≤3.** Split early.
4. **Result types from `@sentient/protocol`.** No throws from business logic.
5. **`bun run test` (Vitest) only.** Never `bun test` (Bun-native).
6. **Logging:** every new file uses `getLog(["sentient", "<component>", "<area>"])`. Truncate previews ≤120 chars.
7. **Configurable values in `gateway/config.yaml` per `.claude/rules/config.md`.** No magic numbers in code.
8. **Pre-existing CLAUDE.md rules:** keep tuned constants, never read `.env`/`.zshrc`, copy-before-analyze for remote, push back on flawed premises.
9. **Stop running sentient-* containers before tests** (port conflict; per memory `feedback_docker_ps_before_tests.md`).
10. **Ground every Hermes-specific decision in upstream source at `/tmp/hermes-agent`** — never guess from memory. The spec's §15 questions are starting points; new questions will arise during implementation. Verify before writing.

---

## Status Reporting (per task or batch)

`DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED`. Surface discrepancies between this plan and actual code (e.g., a method name that doesn't exist) — don't silently rename or invent.

---

## Out-of-scope edits (the whole plan)

This plan touches files listed under each task. **Do not edit anywhere else.** Specifically out of scope unless explicitly listed:

- `gateway/src/cerebrum/` internals beyond what tasks specify (cognitive cycle, attention gate, etc. stay).
- `shared/` packages other than what tasks specify.
- Voice pipeline (`gateway/src/voice/`, `shared/web-sdk/`) — untouched.
- `deploy/pi/` (production compose) — untouched until a follow-up Pi-deploy plan.
- `lefthook.yml`, `package.json`, `tsconfig*.json`, `vite.config.ts`.

If an unlisted edit becomes necessary, surface it before doing it.

---

## Task 0: Worktree + branch setup

**Why:** This plan must run in an isolated worktree (per `superpowers:using-git-worktrees`) so we can iterate without touching `develop`. New branch `feature/sentient-hermes-platform-adapter`.

- [ ] **Step 1: Verify on develop, clean tree**

```bash
cd /Users/kevinye/Development/sentient
git status
git branch --show-current
git log --oneline -3
```

Expected: branch `develop`; latest commit is the merge `bc0c583 Merge: multi-user auth & settings + Phase 7.5 + platform-adapter pivot spec` (or newer); working tree clean.

If not, report `BLOCKED: wrong branch` and stop.

- [ ] **Step 2: Create worktree + new branch**

```bash
cd /Users/kevinye/Development/sentient
git worktree add -b feature/sentient-hermes-platform-adapter \
    .worktrees/sentient-platform-adapter develop
cd .worktrees/sentient-platform-adapter
pwd
git branch --show-current
```

Expected: pwd ends in `.worktrees/sentient-platform-adapter`, branch is the new feature branch.

**All subsequent tasks operate from this worktree.** Source paths in tasks are relative to it.

- [ ] **Step 3: Source env + verify quality gate baseline**

```bash
source scripts/env.sh
bun install
bun run typecheck 2>&1 | tail -5
bun run lint 2>&1 | tail -5
```

Expected: typecheck + lint clean. If not clean, that's a pre-existing issue — record it in the task's status report; do **not** auto-fix unrelated issues.

- [ ] **Step 4: Verify Hermes source is present at `/tmp/hermes-agent`**

```bash
ls /tmp/hermes-agent/gateway/platforms/base.py 2>/dev/null && echo "PRESENT" || echo "MISSING"
```

If MISSING:
```bash
cd /tmp && git clone --depth=1 https://github.com/NousResearch/hermes-agent.git
cd /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter
```

We do **not** vendor this clone in our repo — it's reference material for grounding patches and answering implementation questions.

- [ ] **Step 5: Verify Hermes Docker image is pulled**

```bash
docker image inspect nousresearch/hermes-agent:latest >/dev/null 2>&1 && echo "PRESENT" || echo "MISSING"
```

If MISSING:
```bash
docker pull nousresearch/hermes-agent:v2026.4.16
docker tag nousresearch/hermes-agent:v2026.4.16 nousresearch/hermes-agent:latest
```

We pin `v2026.4.16` (per `deploy/hermes-overlay/HERMES_VERSION`); the `:latest` tag is for local convenience.

- [ ] **Step 6: No commit at end of Task 0** (worktree creation isn't a code change).

---
## Phase A — Python adapter + 5 Hermes patches

The phase produces a buildable `deploy/hermes-overlay/` image that, when run with `SENTIENT_GATEWAY_TOKEN` and `SENTIENT_GATEWAY_PORT` env vars, exposes a single-client WebSocket server which fully participates in `GatewayRunner` (slash commands, hooks, allowlists, tool callbacks).

### Task A.1: Pre-flight upstream reads

**Why:** Nail down the actual upstream APIs we'll subclass and patch against. This task produces no code — it produces grounded notes that subsequent tasks reference.

- [ ] **Step 1: Read `BasePlatformAdapter` interface end-to-end**

```bash
grep -n "def connect\|def disconnect\|def send\|def handle_message\|def _start_session_processing\|def build_source\|def _process_message_background" /tmp/hermes-agent/gateway/platforms/base.py | head -30
```

Then read with `Read`/`sed`/`bat`:
- `gateway/platforms/base.py:985-1200` — `BasePlatformAdapter.__init__`, `connect`, `disconnect`, `send`, `send_typing`, `send_image` signatures.
- `gateway/platforms/base.py:1880-2200` — `handle_message` and friends (the inbound dispatch helper).
- `gateway/platforms/base.py:784-870` — `MessageEvent` and `SendResult` dataclasses.
- `gateway/session.py:69-160` — `SessionSource` dataclass; relevant fields are `platform`, `chat_id`, `user_id`, `chat_type`, `chat_name`.

- [ ] **Step 2: Read the closest reference adapter (api_server)**

```bash
sed -n '1,80p' /tmp/hermes-agent/gateway/platforms/api_server.py
```

We are NOT modeling the dispatch path on api_server (it bypasses GatewayRunner). We ARE modeling the boilerplate: lifecycle, logging tag, `check_*_requirements` helper, `Platform` import.

- [ ] **Step 3: Read webhook adapter for the dispatch-via-`handle_message` pattern**

```bash
sed -n '460,560p' /tmp/hermes-agent/gateway/platforms/webhook.py
```

Webhook is our dispatch model: it constructs a `MessageEvent`, calls `self.handle_message(event)`, and lets `GatewayRunner` route the rest.

- [ ] **Step 4: Confirm tool-callback signatures**

```bash
sed -n '1790,1830p' /tmp/hermes-agent/gateway/platforms/api_server.py
```

The three callbacks we need:
- `tool_start_callback(tool_call_id: str, function_name: str, function_args: dict)`
- `tool_progress_callback(event_type: str, name: str, preview: str, args: dict, **kwargs)`
- `tool_complete_callback(tool_call_id: str, result: Any, status: str)`

These are kwargs to `AIAgent(...)` — we register them via Patch 5.

- [ ] **Step 5: Confirm Platform enum + factory line numbers (used by patches A.7–A.8)**

```bash
grep -n "class Platform\|elif platform == Platform.API_SERVER\|platform_env_map\|platform_allow_all_map" /tmp/hermes-agent/gateway/config.py /tmp/hermes-agent/gateway/run.py | head -20
```

Confirm, write to a scratch note (`/tmp/sentient-plan-notes.txt`):

```
config.py:48           class Platform(Enum):
config.py:69           QQBOT = "qqbot"        # last enum entry today
config.py:853          def _apply_env_overrides(config):
config.py:1052         api_server_key = os.getenv("API_SERVER_KEY", "")
run.py:2747            def _create_adapter(self, platform, config):
run.py:2871            elif platform == Platform.API_SERVER:    # nearest analogue
run.py:2926            platform_env_map = {
run.py:2948            platform_allow_all_map = {
run.py:4035            async def _handle_message_with_agent(...)
toolsets.py:332        "hermes-telegram":              # boilerplate to mirror
toolsets.py:452        "hermes-gateway" includes:      # add our toolset name here
```

These line numbers feed the patches in A.7–A.11.

- [ ] **Step 6: No commit** (read-only research).

**Status:** complete when /tmp/sentient-plan-notes.txt exists with the notes above; patches in subsequent tasks reference it.

---

### Task A.2: Write `sentient_gateway.py` — the adapter

**Why:** This is the file Hermes loads as a platform. It exposes the WS server, dispatches inbound frames into `MessageEvent`s, forwards outbound `send()` calls as WS frames, and exposes the per-session callback bundle Patch 5 wires into `AIAgent`.

**Files:**
- Create: `deploy/hermes-overlay/sentient_gateway.py`

- [ ] **Step 1: Write the full file**

```python
# deploy/hermes-overlay/sentient_gateway.py
"""
Sentient Gateway platform adapter for Hermes.

Single-client WebSocket server. The Bun gateway dials in over the
sentient-internal docker network with a bearer token; one Hermes process
serves one user (chat_id == userId), so we never multiplex multiple users
across one connection.

Contract (frame schema, auth, lifecycle) is defined in:
docs/superpowers/specs/2026-04-26-sentient-hermes-platform-adapter-design.md
sections 5 + 7.

Wired into Hermes via 5 surgical patches (see ../patches/):
- 0001  config.py    Platform.SENTIENT_GATEWAY enum + env loader
- 0002  run.py       _create_adapter factory branch
- 0003  run.py       platform_env_map + platform_allow_all_map entries
- 0004  toolsets.py  hermes-sentient-gateway toolset entry
- 0005  run.py       per-session tool-callback bundle threaded through
                     to AIAgent in _handle_message_with_agent
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Optional

import aiohttp
from aiohttp import web

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import SessionSource

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Frame protocol — must match docs/.../platform-adapter-design.md §7
# --------------------------------------------------------------------------

PROTOCOL_VERSION = "1.0"

# WS close codes
WS_CLOSE_PROTOCOL_ERROR = 1002
WS_CLOSE_UNSUPPORTED_DATA = 1003
WS_CLOSE_BAD_VERSION = 1008

# Auth header
AUTH_HEADER = "Authorization"
AUTH_PREFIX = "Bearer "


def check_sentient_gateway_requirements() -> bool:
    """Module-level requirement check called by run.py:_create_adapter()."""
    return True  # only depends on aiohttp which Hermes already pulls in


@dataclass
class _PendingTurn:
    """Tracks an in-flight user.message → assistant.message cycle so the adapter
    can correlate tool callbacks back to the originating user-message seq."""

    user_seq: int
    started_at: float


class SentientGatewayAdapter(BasePlatformAdapter):
    """Sentient Gateway platform adapter.

    One adapter per Hermes process. Hosts an aiohttp-based WS server that
    accepts a single client connection (the Bun gateway). All WS frames
    are JSON, line-delimited per WS message.

    The adapter does not own session state — Hermes' GatewayRunner +
    state.db do. We just translate frames in both directions.
    """

    PLATFORM = Platform.SENTIENT_GATEWAY

    def __init__(self, config: PlatformConfig) -> None:
        super().__init__(config, Platform.SENTIENT_GATEWAY)
        self._token: str = os.getenv("SENTIENT_GATEWAY_TOKEN", "").strip()
        port_str: str = os.getenv("SENTIENT_GATEWAY_PORT", "").strip()
        try:
            self._port: int = int(port_str) if port_str else 8650
        except ValueError:
            logger.error(
                "Invalid SENTIENT_GATEWAY_PORT=%r; falling back to 8650",
                port_str,
            )
            self._port = 8650

        # The single allowed connection. None = no client connected.
        self._client: Optional[web.WebSocketResponse] = None
        self._client_lock = asyncio.Lock()

        # Server lifecycle handles
        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None

        # Outbound seq counter (Hermes → Bun direction)
        self._out_seq: int = 0

        # Per-session pending turns, keyed by chat_id (== userId in our case).
        # Lets tool-callback frames carry the right `ref` back.
        self._pending: Dict[str, _PendingTurn] = {}

    # ----------------------------------------------------------------------
    # Lifecycle
    # ----------------------------------------------------------------------

    async def connect(self) -> bool:
        """Start the embedded aiohttp WS server."""
        if not self._token:
            logger.error("SENTIENT_GATEWAY_TOKEN env var missing or empty")
            return False

        self._app = web.Application()
        self._app.router.add_get("/ws", self._handle_ws_upgrade)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, "0.0.0.0", self._port)
        await self._site.start()
        logger.info(
            "sentient-gateway adapter listening on 0.0.0.0:%d (token-fingerprint=%s...%s)",
            self._port,
            self._token[:4],
            self._token[-4:],
        )
        return True

    async def disconnect(self) -> None:
        """Stop the server and close any open client."""
        async with self._client_lock:
            if self._client and not self._client.closed:
                await self._client.close()
            self._client = None
        if self._site:
            await self._site.stop()
        if self._runner:
            await self._runner.cleanup()
        logger.info("sentient-gateway adapter stopped")

    # ----------------------------------------------------------------------
    # Outbound — Hermes → Bun
    # ----------------------------------------------------------------------

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Forward an assistant message to the connected client."""
        pending = self._pending.pop(chat_id, None)
        ref = pending.user_seq if pending else None
        await self._push({
            "type": "assistant.message",
            "seq": self._next_out_seq(),
            "ref": ref,
            "text": content,
        })
        return SendResult(success=True, message_id=None)

    async def send_typing(self, chat_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """No-op: voice clients have no typing indicator."""
        return None

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        """Ignored in v1; voice clients don't render images."""
        return SendResult(success=True, message_id=None)

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        """Ignored: Bun owns audio out via its own TTS pipeline."""
        return SendResult(success=True, message_id=None)

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        return SendResult(success=True, message_id=None)

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        return SendResult(success=True, message_id=None)

    def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "voice", "chat_id": chat_id}

    # ----------------------------------------------------------------------
    # Tool callback bundle (consumed by Patch 5 in run.py)
    # ----------------------------------------------------------------------

    def make_tool_callbacks(self, chat_id: str) -> Dict[str, Callable[..., None]]:
        """Returns the three callbacks AIAgent expects, bound to the
        currently-pending turn for `chat_id`. Patch 5 calls this from
        _handle_message_with_agent and threads the result into
        AIAgent(...)."""

        def _ref_for(chat_id: str) -> Optional[int]:
            pending = self._pending.get(chat_id)
            return pending.user_seq if pending else None

        def _on_tool_start(tool_call_id: str, function_name: str, function_args: Any) -> None:
            args_summary = self._summarize(function_args)
            self._fire_and_forget(self._push({
                "type": "tool.start",
                "seq": self._next_out_seq(),
                "ref": _ref_for(chat_id),
                "tool_call_id": tool_call_id,
                "name": function_name,
                "args_summary": args_summary,
            }))

        def _on_tool_progress(event_type: str, name: str, preview: str, args: Any, **_kw: Any) -> None:
            # Hermes also fires this for the chat_completions text-delta
            # path. We only forward when it carries a tool-call shape.
            tool_call_id = _kw.get("tool_call_id") or ""
            if not tool_call_id:
                return
            self._fire_and_forget(self._push({
                "type": "tool.progress",
                "seq": self._next_out_seq(),
                "ref": _ref_for(chat_id),
                "tool_call_id": tool_call_id,
                "message": self._summarize(preview),
            }))

        def _on_tool_complete(tool_call_id: str, result: Any, status: str = "ok") -> None:
            self._fire_and_forget(self._push({
                "type": "tool.end",
                "seq": self._next_out_seq(),
                "ref": _ref_for(chat_id),
                "tool_call_id": tool_call_id,
                "status": status if status in ("ok", "error") else "ok",
                "result_summary": self._summarize(result),
            }))

        return {
            "tool_start_callback": _on_tool_start,
            "tool_progress_callback": _on_tool_progress,
            "tool_complete_callback": _on_tool_complete,
        }

    # ----------------------------------------------------------------------
    # Inbound — WS upgrade + read loop
    # ----------------------------------------------------------------------

    async def _handle_ws_upgrade(self, request: web.Request) -> web.WebSocketResponse:
        # Auth check
        auth = request.headers.get(AUTH_HEADER, "")
        if not auth.startswith(AUTH_PREFIX) or auth[len(AUTH_PREFIX):].strip() != self._token:
            logger.warning("Rejecting WS upgrade: bad/missing auth")
            return web.Response(status=401, text="unauthorized")

        ws = web.WebSocketResponse(heartbeat=30, autoclose=True)
        await ws.prepare(request)

        # Single-client invariant: close any existing connection.
        async with self._client_lock:
            if self._client is not None and not self._client.closed:
                logger.info("Closing previous WS client (single-client invariant)")
                await self._client.close()
            self._client = ws
            self._out_seq = 0  # reset seq for the new connection

        try:
            await self._read_loop(ws)
        finally:
            async with self._client_lock:
                if self._client is ws:
                    self._client = None
        return ws

    async def _read_loop(self, ws: web.WebSocketResponse) -> None:
        hello_seen = False
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                if msg.type == aiohttp.WSMsgType.ERROR:
                    logger.warning("WS error: %s", ws.exception())
                continue
            try:
                frame = json.loads(msg.data)
            except json.JSONDecodeError:
                logger.warning("Malformed JSON; closing")
                await ws.close(code=WS_CLOSE_UNSUPPORTED_DATA)
                return

            ftype = frame.get("type")
            if not hello_seen and ftype != "hello":
                logger.warning("Expected hello first; got type=%s", ftype)
                await ws.close(code=WS_CLOSE_PROTOCOL_ERROR)
                return

            if ftype == "hello":
                if hello_seen:
                    logger.warning("Duplicate hello; closing")
                    await ws.close(code=WS_CLOSE_PROTOCOL_ERROR)
                    return
                version = str(frame.get("version", ""))
                if not version.startswith("1."):
                    logger.warning("Unsupported version: %s", version)
                    await ws.close(code=WS_CLOSE_BAD_VERSION)
                    return
                hello_seen = True
                await self._push({
                    "type": "hello.ack",
                    "seq": self._next_out_seq(),
                    "version": PROTOCOL_VERSION,
                    "server": "sentient-gateway-adapter",
                })
                continue

            if ftype == "user.message":
                await self._handle_user_message(frame)
            elif ftype == "user.cancel":
                await self._handle_user_cancel(frame)
            elif ftype == "ping":
                await self._push({
                    "type": "pong",
                    "seq": self._next_out_seq(),
                    "ref": frame.get("seq"),
                })
            else:
                logger.warning("Unknown frame type: %s; ignoring", ftype)

    async def _handle_user_message(self, frame: Dict[str, Any]) -> None:
        text = str(frame.get("text", ""))
        seq = int(frame.get("seq", 0))
        internal = bool(frame.get("internal", False))

        chat_id = self.config.profile_name or "default"  # Hermes profile name == userId
        source = self.build_source(
            chat_id=chat_id,
            chat_name=chat_id,
            chat_type="dm",
            user_id=chat_id,
            user_name=chat_id,
        )
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            internal=internal,
        )
        # Track the seq so outbound frames can carry `ref`.
        self._pending[chat_id] = _PendingTurn(user_seq=seq, started_at=time.monotonic())
        await self.handle_message(event)

    async def _handle_user_cancel(self, frame: Dict[str, Any]) -> None:
        chat_id = self.config.profile_name or "default"
        # Trigger Hermes' per-session interrupt event. Set in
        # BasePlatformAdapter._active_sessions during _start_session_processing.
        active_event = self._active_sessions.get(chat_id) if hasattr(self, "_active_sessions") else None
        if active_event is not None:
            active_event.set()

    # ----------------------------------------------------------------------
    # Helpers
    # ----------------------------------------------------------------------

    def _next_out_seq(self) -> int:
        self._out_seq += 1
        return self._out_seq

    async def _push(self, frame: Dict[str, Any]) -> None:
        async with self._client_lock:
            ws = self._client
        if ws is None or ws.closed:
            return  # silently drop; reconnect is the client's job
        try:
            await ws.send_json(frame)
        except (ConnectionResetError, RuntimeError) as exc:
            logger.warning("Failed to send frame %s: %s", frame.get("type"), exc)

    def _fire_and_forget(self, coro: Awaitable[None]) -> None:
        loop = asyncio.get_running_loop()
        loop.create_task(coro)

    def _summarize(self, value: Any, max_len: int = 120) -> str:
        try:
            text = json.dumps(value, default=str) if not isinstance(value, str) else value
        except (TypeError, ValueError):
            text = repr(value)
        return text if len(text) <= max_len else text[: max_len - 3] + "..."
```

- [ ] **Step 2: Add the file to git (do not commit yet — patches need to land first)**

```bash
git add deploy/hermes-overlay/sentient_gateway.py
git status -s deploy/hermes-overlay/
```

Expected: `A  deploy/hermes-overlay/sentient_gateway.py`.

- [ ] **Step 3: Syntax-check the Python (no Hermes deps available locally — just python -c)**

```bash
python3 -c "import ast; ast.parse(open('deploy/hermes-overlay/sentient_gateway.py').read())" && echo OK
```

Expected: `OK`. (Imports of `gateway.config` etc. won't resolve outside the Hermes container — that's fine; ast.parse only checks syntax.)

- [ ] **Step 4: No commit yet** — full Phase A commit lands after patches + image build verifies.

---

### Task A.3: Patch 0001 — `Platform.SENTIENT_GATEWAY` enum + env loader

**Why:** Without this, Hermes literally cannot represent "this message came from sentient_gateway" — no enum value to use as a key in adapter factory or auth maps.

**Files:**
- Create: `deploy/hermes-overlay/patches/0001-config-platform-enum.patch`

- [ ] **Step 1: Confirm exact upstream lines once more**

```bash
sed -n '48,70p' /tmp/hermes-agent/gateway/config.py
sed -n '1050,1058p' /tmp/hermes-agent/gateway/config.py
```

Expected: enum body ending with `QQBOT = "qqbot"` at line 69; `api_server_key = os.getenv("API_SERVER_KEY", "")` block around line 1052.

- [ ] **Step 2: Write the patch**

```diff
--- a/gateway/config.py
+++ b/gateway/config.py
@@ -66,6 +66,7 @@ class Platform(Enum):
     WECOM_CALLBACK = "wecom_callback"
     WEIXIN = "weixin"
     BLUEBUBBLES = "bluebubbles"
     QQBOT = "qqbot"
+    SENTIENT_GATEWAY = "sentient_gateway"
 
 
 @dataclass
@@ -1052,6 +1053,17 @@ def _apply_env_overrides(config: GatewayConfig) -> None:
     api_server_key = os.getenv("API_SERVER_KEY", "")
     api_server_port = os.getenv("API_SERVER_PORT")
 
+    # Sentient Gateway custom adapter (deploy/hermes-overlay/sentient_gateway.py).
+    # Enabled when SENTIENT_GATEWAY_TOKEN is set; required env. Optional
+    # SENTIENT_GATEWAY_PORT defaults to 8650 inside the adapter.
+    sentient_gateway_token = os.getenv("SENTIENT_GATEWAY_TOKEN", "").strip()
+    if sentient_gateway_token:
+        if Platform.SENTIENT_GATEWAY not in config.platforms:
+            config.platforms[Platform.SENTIENT_GATEWAY] = PlatformConfig()
+        cfg = config.platforms[Platform.SENTIENT_GATEWAY]
+        cfg.enabled = True
+        cfg.token = sentient_gateway_token
+
     if api_server_key or api_server_port:
         if Platform.API_SERVER not in config.platforms:
             config.platforms[Platform.API_SERVER] = PlatformConfig()
```

Save this exactly to `deploy/hermes-overlay/patches/0001-config-platform-enum.patch`.

- [ ] **Step 3: Verify the patch applies cleanly to the upstream tree**

```bash
cd /tmp/hermes-agent
patch --dry-run -p1 < /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter/deploy/hermes-overlay/patches/0001-config-platform-enum.patch
echo "exit=$?"
```

Expected: `Hunk #1 succeeded` for both hunks; exit=0. Restore your shell to the worktree:

```bash
cd /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter
```

- [ ] **Step 4: No commit yet — patches commit together at end of Phase A.**

---

### Task A.4: Patch 0002 — adapter factory branch in `_create_adapter`

**Why:** Without this, even with the enum entry, Hermes' factory can't construct `SentientGatewayAdapter` when it sees `Platform.SENTIENT_GATEWAY` in `config.platforms`.

**Files:**
- Create: `deploy/hermes-overlay/patches/0002-run-adapter-factory.patch`

- [ ] **Step 1: Confirm context — the API_SERVER branch is the closest analogue**

```bash
sed -n '2871,2900p' /tmp/hermes-agent/gateway/run.py
```

We append after the QQBOT branch (the current last `elif`).

- [ ] **Step 2: Write the patch**

```diff
--- a/gateway/run.py
+++ b/gateway/run.py
@@ -2898,6 +2898,13 @@ class GatewayRunner:
             return QQAdapter(config)
 
+        elif platform == Platform.SENTIENT_GATEWAY:
+            from gateway.platforms.sentient_gateway import SentientGatewayAdapter, check_sentient_gateway_requirements
+            if not check_sentient_gateway_requirements():
+                logger.warning("Sentient Gateway: dependencies not met")
+                return None
+            return SentientGatewayAdapter(config)
+
         else:
             logger.warning("Unknown platform: %s", platform)
             return None
```

Save to `deploy/hermes-overlay/patches/0002-run-adapter-factory.patch`.

> **Note:** the `else: return None` block above this insertion may not exist exactly as shown; verify with the actual upstream tail of `_create_adapter` before saving. If upstream's tail differs, adjust the patch's trailing context to match. Run the dry-run check below first.

- [ ] **Step 3: Confirm tail of `_create_adapter`**

```bash
sed -n '2895,2915p' /tmp/hermes-agent/gateway/run.py
```

Match the patch's trailing-context lines to whatever appears after the QQBOT branch. Edit the patch to match if the `else:` differs.

- [ ] **Step 4: Verify patch applies**

```bash
cd /tmp/hermes-agent
patch --dry-run -p1 < /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter/deploy/hermes-overlay/patches/0002-run-adapter-factory.patch
echo "exit=$?"
cd -
```

Expected: exit=0. If not: re-read the trailing context, fix patch, re-dry-run.

- [ ] **Step 5: No commit yet.**

---

### Task A.5: Patch 0003 — auth maps

**Why:** `_is_user_authorized` rejects all messages from a platform that isn't in `platform_env_map` (or has `*_ALLOW_ALL_USERS` set). Without this patch our adapter's `MessageEvent`s never reach the agent.

We use `SENTIENT_GATEWAY_ALLOW_ALL_USERS=true` as the runtime opt-in, since the Bun gateway is the auth perimeter — users already authenticated via PASETO before any frame leaves Bun.

**Files:**
- Create: `deploy/hermes-overlay/patches/0003-run-auth-maps.patch`

- [ ] **Step 1: Confirm context**

```bash
sed -n '2940,2966p' /tmp/hermes-agent/gateway/run.py
```

Verify last entry in `platform_allow_all_map` is the QQBOT one.

- [ ] **Step 2: Write the patch**

```diff
--- a/gateway/run.py
+++ b/gateway/run.py
@@ -2941,6 +2941,7 @@ class GatewayRunner:
             Platform.WEIXIN: "WEIXIN_ALLOWED_USERS",
             Platform.BLUEBUBBLES: "BLUEBUBBLES_ALLOWED_USERS",
             Platform.QQBOT: "QQ_ALLOWED_USERS",
+            Platform.SENTIENT_GATEWAY: "SENTIENT_GATEWAY_ALLOWED_USERS",
         }
         platform_group_env_map = {
             Platform.TELEGRAM: "TELEGRAM_GROUP_ALLOWED_USERS",
@@ -2962,6 +2963,7 @@ class GatewayRunner:
             Platform.WEIXIN: "WEIXIN_ALLOW_ALL_USERS",
             Platform.BLUEBUBBLES: "BLUEBUBBLES_ALLOW_ALL_USERS",
             Platform.QQBOT: "QQ_ALLOW_ALL_USERS",
+            Platform.SENTIENT_GATEWAY: "SENTIENT_GATEWAY_ALLOW_ALL_USERS",
         }
```

There's also the second `platform_env_map` near `run.py:3079` (used by `get_connected_platforms` per `ADDING_A_PLATFORM.md`). Patch that one too:

```diff
@@ -3079,6 +3081,7 @@ class GatewayRunner:
             platform_env_map = {
                 Platform.TELEGRAM: "TELEGRAM_TOKEN",
                 Platform.DISCORD: "DISCORD_BOT_TOKEN",
                 # ... preserve existing entries verbatim ...
                 Platform.QQBOT: "QQ_APP_ID",
+                Platform.SENTIENT_GATEWAY: "SENTIENT_GATEWAY_TOKEN",
             }
```

- [ ] **Step 3: Confirm the second map's full body before finalizing**

```bash
sed -n '3079,3100p' /tmp/hermes-agent/gateway/run.py
```

Update the patch hunk to include the actual surrounding lines verbatim (the `# ... preserve existing ...` placeholder above is illustrative — the real patch must have full context lines).

- [ ] **Step 4: Verify patch applies**

```bash
cd /tmp/hermes-agent
patch --dry-run -p1 < /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter/deploy/hermes-overlay/patches/0003-run-auth-maps.patch
echo "exit=$?"
cd -
```

- [ ] **Step 5: No commit yet.**

---

### Task A.6: Patch 0004 — toolset entry

**Why:** Hermes assigns each platform a default toolset that gates which tools are exposed to the LLM. Without an entry our adapter's sessions get a default empty toolset and the LLM has no tools.

**Files:**
- Create: `deploy/hermes-overlay/patches/0004-toolsets.patch`

- [ ] **Step 1: Confirm context — model on `hermes-telegram`**

```bash
sed -n '332,338p' /tmp/hermes-agent/toolsets.py
sed -n '449,455p' /tmp/hermes-agent/toolsets.py
```

- [ ] **Step 2: Write the patch**

```diff
--- a/toolsets.py
+++ b/toolsets.py
@@ -445,6 +445,11 @@ TOOLSETS = {
         "tools": _HERMES_CORE_TOOLS,
         "includes": []
     },
+    "hermes-sentient-gateway": {
+        "description": "Sentient Gateway voice platform — voice clients via custom adapter",
+        "tools": _HERMES_CORE_TOOLS,
+        "includes": []
+    },
     "hermes-gateway": {
-        "includes": ["hermes-telegram", "hermes-discord", "hermes-whatsapp", "hermes-slack", "hermes-signal", "hermes-bluebubbles", "hermes-homeassistant", "hermes-email", "hermes-sms", "hermes-mattermost", "hermes-matrix", "hermes-dingtalk", "hermes-feishu", "hermes-wecom", "hermes-wecom-callback", "hermes-weixin", "hermes-qqbot", "hermes-webhook"]
+        "includes": ["hermes-telegram", "hermes-discord", "hermes-whatsapp", "hermes-slack", "hermes-signal", "hermes-bluebubbles", "hermes-homeassistant", "hermes-email", "hermes-sms", "hermes-mattermost", "hermes-matrix", "hermes-dingtalk", "hermes-feishu", "hermes-wecom", "hermes-wecom-callback", "hermes-weixin", "hermes-qqbot", "hermes-webhook", "hermes-sentient-gateway"]
     },
```

> **IMPORTANT:** the line preceding our insert (the closing `}` of the prior toolset entry) and the second hunk's exact `"includes": [...]` line must match upstream verbatim — copy from `sed -n '449,455p'` output, not from this snippet.

- [ ] **Step 3: Verify patch applies**

```bash
cd /tmp/hermes-agent
patch --dry-run -p1 < /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter/deploy/hermes-overlay/patches/0004-toolsets.patch
echo "exit=$?"
cd -
```

- [ ] **Step 4: No commit yet.**

---

### Task A.7: Patch 0005 — tool-callback wiring in `_handle_message_with_agent`

**Why:** Without this, our adapter's `make_tool_callbacks(chat_id)` is never invoked. The frames `tool.start` / `tool.progress` / `tool.end` would never reach Bun. This is the patch that closes the loop on the spec's §7 tool-progress contract.

**Files:**
- Create: `deploy/hermes-overlay/patches/0005-run-adapter-tool-callbacks.patch`

- [ ] **Step 1: Find the AIAgent construction site**

```bash
grep -n "AIAgent(" /tmp/hermes-agent/gateway/run.py | head -10
sed -n '4035,4200p' /tmp/hermes-agent/gateway/run.py | head -80
```

We need the exact lines where `AIAgent(...)` is constructed inside `_handle_message_with_agent`. The patch threads three new kwargs into that call **only when** `event.source.platform == Platform.SENTIENT_GATEWAY`.

- [ ] **Step 2: Read enough context to write the patch**

Read 80–150 lines starting from the construction site. We need:
- The variable holding the adapter for the originating platform (likely `self._adapters[platform]` or similar).
- The exact `AIAgent(...)` call and its existing kwargs.

Capture the variables and signature into a scratch note so the patch text is exact.

- [ ] **Step 3: Write the patch**

The patch shape (illustrative — finalize against actual upstream after Step 2):

```diff
--- a/gateway/run.py
+++ b/gateway/run.py
@@ -4140,6 +4140,18 @@ class GatewayRunner:
+        # Sentient Gateway: surface tool-call events back to the Bun gateway
+        # via the adapter's per-session callback bundle so the webui's tool-
+        # progress UI receives tool.start / tool.progress / tool.end frames.
+        sentient_callbacks = {}
+        if event.source.platform == Platform.SENTIENT_GATEWAY:
+            adapter = self._adapters.get(Platform.SENTIENT_GATEWAY)
+            if adapter is not None and hasattr(adapter, "make_tool_callbacks"):
+                sentient_callbacks = adapter.make_tool_callbacks(event.source.chat_id)
+
         agent = AIAgent(
             # ... existing kwargs ...
+            tool_start_callback=sentient_callbacks.get("tool_start_callback"),
+            tool_progress_callback=sentient_callbacks.get("tool_progress_callback"),
+            tool_complete_callback=sentient_callbacks.get("tool_complete_callback"),
         )
```

> **CRITICAL:** the `# ... existing kwargs ...` placeholder above must be replaced with the actual existing kwargs from upstream so `patch -p1` finds matching context lines. Patches are not free-form; they need exact byte-for-byte context.

- [ ] **Step 4: Verify patch applies**

```bash
cd /tmp/hermes-agent
patch --dry-run -p1 < /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter/deploy/hermes-overlay/patches/0005-run-adapter-tool-callbacks.patch
echo "exit=$?"
cd -
```

If non-zero: read the actual upstream lines surrounding the call site and rewrite the patch's context lines.

- [ ] **Step 5: No commit yet.**

---

### Task A.8: Build the overlay image

**Why:** The patches and adapter are only useful if they actually compose into a runnable image.

- [ ] **Step 1: Build**

```bash
cd /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter
docker build \
  --build-arg HERMES_VERSION=$(cat deploy/hermes-overlay/HERMES_VERSION) \
  -t sentient/hermes:local \
  deploy/hermes-overlay/ 2>&1 | tail -40
```

Expected: every `patch -p1` line says `Hunk #N succeeded`, ending with `Successfully tagged sentient/hermes:local`.

If a patch fails: re-read the upstream file at the pinned version, fix the patch, rebuild. **Do not** use `patch -p1 --fuzz` to paper over context drift — patches must be precise.

- [ ] **Step 2: Inspect image presence**

```bash
docker images sentient/hermes:local
```

Expected: a row with the image and a recent timestamp.

- [ ] **Step 3: No commit yet — smoke test next.**

---

### Task A.9: Live smoke probe — boot one profile, dial WS, verify slash dispatch

**Why:** Source-confirms that:
1. Hermes loads our adapter (no Python import error).
2. `/v1/models` advertises the profile.
3. WS auth works.
4. `user.message` carrying `/personality` actually dispatches through `GatewayRunner` (not silently treated as user text).

This is also our first end-to-end confidence that Patches 1-4 work; Patch 5 is verified later in Phase B once we have a real Bun client.

- [ ] **Step 1: Stage probe profile**

```bash
mkdir -p /tmp/sentient-probe-home/profiles/u_probe
cat > /tmp/sentient-probe-home/profiles/u_probe/.env <<'EOF'
SENTIENT_GATEWAY_TOKEN=probe-token-aaaa-bbbb
SENTIENT_GATEWAY_PORT=8650
SENTIENT_GATEWAY_ALLOW_ALL_USERS=true
GATEWAY_ALLOW_ALL_USERS=true
API_SERVER_ENABLED=true
API_SERVER_KEY=probe-api-key
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
EOF
cat > /tmp/sentient-probe-home/profiles/u_probe/config.yaml <<'EOF'
agent:
  model: openai/gpt-4o-mini
  personalities:
    helpful: "You are a helpful, friendly AI assistant."
    concise: "Keep it brief."
EOF
```

- [ ] **Step 2: Boot the overlay against this profile**

```bash
docker rm -f hermes-probe 2>/dev/null
docker run -d --name hermes-probe \
  -e HERMES_HOME=/data/profiles/u_probe \
  -e SENTIENT_GATEWAY_TOKEN=probe-token-aaaa-bbbb \
  -e SENTIENT_GATEWAY_PORT=8650 \
  -e SENTIENT_GATEWAY_ALLOW_ALL_USERS=true \
  -e GATEWAY_ALLOW_ALL_USERS=true \
  -e API_SERVER_ENABLED=true \
  -e API_SERVER_KEY=probe-api-key \
  -p 18642:8642 -p 18650:8650 \
  -v /tmp/sentient-probe-home:/data \
  sentient/hermes:local hermes -p u_probe gateway run

sleep 8
docker ps --filter name=hermes-probe --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
docker logs hermes-probe 2>&1 | tail -30
```

Expected: container Up; logs include `sentient-gateway adapter listening on 0.0.0.0:8650 (token-fingerprint=prob...bbbb)`.

If logs show `Unknown platform: SENTIENT_GATEWAY` or an import error → patches misapplied; rebuild after fixing.

- [ ] **Step 3: Verify health + models**

```bash
curl -sS http://127.0.0.1:18642/health
echo
curl -sS -H "Authorization: Bearer probe-api-key" http://127.0.0.1:18642/v1/models
```

Expected: `{"status": "ok", ...}`; `/v1/models` advertises a model with id `u_probe` (or `hermes-agent`).

- [ ] **Step 4: Dial the WS, send `hello` + a slash command**

Use `wscat` (`npm i -g wscat`) or `python -m websockets.cli`. The spec uses `/personality`:

```bash
cat > /tmp/probe-ws.py <<'EOF'
import asyncio, json, sys
import websockets

URL = "ws://127.0.0.1:18650/ws"
TOKEN = "probe-token-aaaa-bbbb"

async def main():
    async with websockets.connect(URL, additional_headers={"Authorization": f"Bearer {TOKEN}"}) as ws:
        await ws.send(json.dumps({"type": "hello", "version": "1.0", "client": "probe"}))
        ack = await ws.recv()
        print("ACK:", ack)
        await ws.send(json.dumps({"type": "user.message", "seq": 1, "text": "/personality concise", "internal": True}))
        # Expect an assistant.message confirming personality switch
        async for msg in ws:
            print("RECV:", msg)
            if json.loads(msg).get("type") == "assistant.message":
                break

asyncio.run(main())
EOF

python3 -m pip install --quiet websockets 2>&1 | tail -1 || true
python3 /tmp/probe-ws.py 2>&1 | head -20
```

Expected: `ACK:` shows `{"type":"hello.ack",...}`; `RECV:` includes a `tool.start`/`tool.end` cycle (if the LLM uses tools to confirm) OR an `assistant.message` whose `text` includes "Personality set to concise" or similar Hermes confirmation copy.

If the WS call fails with 401 → token mismatch; recheck env.
If `assistant.message` text reads `(no personality)` or repeats `/personality concise` as user input → Patches 2-3 didn't apply; the message went through `api_server` path or the platform isn't recognized.

- [ ] **Step 5: Tear down**

```bash
docker rm -f hermes-probe
rm -rf /tmp/sentient-probe-home /tmp/probe-ws.py
```

- [ ] **Step 6: No commit yet — final Phase A commit covers everything next.**

---

### Task A.10: Phase A commit

**Why:** A single semantic commit per phase keeps history readable.

- [ ] **Step 1: Confirm staging**

```bash
git status
git diff --cached --stat | head -30
```

Expected staged: 1 new Python file + 5 new patch files. No other modifications.

- [ ] **Step 2: Stage if anything was missed**

```bash
git add deploy/hermes-overlay/sentient_gateway.py deploy/hermes-overlay/patches/
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(hermes-overlay): platform adapter + 5 source patches" -m "$(cat <<'EOF'
sentient_gateway.py registers as Platform.SENTIENT_GATEWAY, hosts a
single-client aiohttp WS server (auth via SENTIENT_GATEWAY_TOKEN bearer),
constructs MessageEvent on user.message frames, dispatches via
self.handle_message() so GatewayRunner runs slash commands / hooks /
allowlists / tool callbacks, and forwards adapter.send() output as
assistant.message frames. Tool callbacks are surfaced via
make_tool_callbacks(chat_id) for Patch 5 to thread into AIAgent.

Patches:
  0001  config.py     Platform enum + env loader for SENTIENT_GATEWAY_TOKEN
  0002  run.py        _create_adapter factory branch
  0003  run.py        platform_env_map + platform_allow_all_map
  0004  toolsets.py   hermes-sentient-gateway toolset + composite include
  0005  run.py        tool_*_callback threaded through to AIAgent

Verified: docker build deploy/hermes-overlay/ succeeds; smoke probe boots
a single profile, dials WS over the new contract, /personality concise
dispatches through GatewayRunner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify**

```bash
git log --oneline -3
```

Expected: top commit is the Phase A commit. Pre-commit hooks should pass (no TypeScript touched; lint is content-aware).

---

## Phase B — Bun-side adapter client (replaces `gateway/src/cerebrum/hermes-client.ts`)

The phase produces a working Bun-side WS client that connects N profile processes, multiplexes nothing per-connection, translates frames to the existing `HermesEvent` shape so cerebrum/webui code paths don't change. Verified end-to-end against the Phase A overlay image.

**Contract preservation:** the existing `HermesClient` interface (`gateway/src/cerebrum/hermes-client.ts:23`) and the `HermesEvent` / `HermesTurnInput` types stay. Only the implementation behind `HermesClient` changes — from `HttpHermesClient` (HTTP+SSE) to `WsHermesClient` (multiplexes per-profile WS connections).

### Task B.1: Define WS frame zod schemas

**Files:**
- Create: `gateway/src/hermes-adapter-client/ws-frames.ts`
- Create: `gateway/src/hermes-adapter-client/ws-frames.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/hermes-adapter-client/ws-frames.test.ts
import { describe, expect, it } from "vitest";
import {
  parseFrame,
  type AnyFrame,
  type HelloAckFrame,
  type AssistantMessageFrame,
  type ToolStartFrame,
  type ToolEndFrame,
  type AssistantErrorFrame,
  type PongFrame,
} from "./ws-frames.ts";

describe("parseFrame", () => {
  it("parses hello.ack", () => {
    const r = parseFrame({ type: "hello.ack", seq: 1, version: "1.0", server: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect((r.value as HelloAckFrame).server).toBe("x");
  });

  it("parses assistant.message with ref", () => {
    const r = parseFrame({ type: "assistant.message", seq: 5, ref: 1, text: "hi" });
    expect(r.ok).toBe(true);
  });

  it("parses tool.start / tool.progress / tool.end", () => {
    const a = parseFrame({ type: "tool.start", seq: 2, ref: 1, tool_call_id: "c1", name: "web_search", args_summary: "q=foo" });
    const b = parseFrame({ type: "tool.progress", seq: 3, ref: 1, tool_call_id: "c1", message: "fetched 1 of 3" });
    const c = parseFrame({ type: "tool.end", seq: 4, ref: 1, tool_call_id: "c1", status: "ok", result_summary: "3 results" });
    expect(a.ok && b.ok && c.ok).toBe(true);
  });

  it("rejects unknown type", () => {
    const r = parseFrame({ type: "unknown", seq: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects bad shape", () => {
    const r = parseFrame({ type: "user.message" }); // missing required fields
    expect(r.ok).toBe(false);
  });

  it("tool.end status is ok|error", () => {
    const bad = parseFrame({ type: "tool.end", seq: 4, ref: 1, tool_call_id: "x", status: "wat", result_summary: "" });
    expect(bad.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter
source scripts/env.sh
cd gateway && bun run test ./src/hermes-adapter-client/ws-frames.test.ts 2>&1 | tail -10
```

Expected: file-not-found error.

- [ ] **Step 3: Implement**

```ts
// gateway/src/hermes-adapter-client/ws-frames.ts
import { z } from "zod";
import type { Result } from "@sentient/protocol";

const helloAck = z.object({
  type: z.literal("hello.ack"),
  seq: z.number().int().nonnegative(),
  version: z.string(),
  server: z.string(),
});

const assistantMessage = z.object({
  type: z.literal("assistant.message"),
  seq: z.number().int().nonnegative(),
  ref: z.number().int().nullable(),
  text: z.string(),
});

const assistantError = z.object({
  type: z.literal("assistant.error"),
  seq: z.number().int().nonnegative(),
  ref: z.number().int().nullable(),
  reason: z.string(),
});

const toolStart = z.object({
  type: z.literal("tool.start"),
  seq: z.number().int().nonnegative(),
  ref: z.number().int().nullable(),
  tool_call_id: z.string(),
  name: z.string(),
  args_summary: z.string(),
});

const toolProgress = z.object({
  type: z.literal("tool.progress"),
  seq: z.number().int().nonnegative(),
  ref: z.number().int().nullable(),
  tool_call_id: z.string(),
  message: z.string(),
});

const toolEnd = z.object({
  type: z.literal("tool.end"),
  seq: z.number().int().nonnegative(),
  ref: z.number().int().nullable(),
  tool_call_id: z.string(),
  status: z.enum(["ok", "error"]),
  result_summary: z.string(),
});

const pong = z.object({
  type: z.literal("pong"),
  seq: z.number().int().nonnegative(),
  ref: z.number().int().nullable(),
});

const frameSchema = z.discriminatedUnion("type", [
  helloAck,
  assistantMessage,
  assistantError,
  toolStart,
  toolProgress,
  toolEnd,
  pong,
]);

export type HelloAckFrame = z.infer<typeof helloAck>;
export type AssistantMessageFrame = z.infer<typeof assistantMessage>;
export type AssistantErrorFrame = z.infer<typeof assistantError>;
export type ToolStartFrame = z.infer<typeof toolStart>;
export type ToolProgressFrame = z.infer<typeof toolProgress>;
export type ToolEndFrame = z.infer<typeof toolEnd>;
export type PongFrame = z.infer<typeof pong>;
export type AnyFrame = z.infer<typeof frameSchema>;

export type ParseError = { kind: "parse-failed"; reason: string };

export function parseFrame(raw: unknown): Result<AnyFrame, ParseError> {
  const r = frameSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: { kind: "parse-failed", reason: r.error.message } };
}

// --- outbound (Bun -> Hermes) frame builders ---

export interface HelloOut { type: "hello"; version: "1.0"; client: "sentient-bun" }
export interface UserMessageOut { type: "user.message"; seq: number; text: string; internal?: boolean }
export interface UserCancelOut { type: "user.cancel"; seq: number; ref: number }
export interface PingOut { type: "ping"; seq: number }
export type OutboundFrame = HelloOut | UserMessageOut | UserCancelOut | PingOut;
```

- [ ] **Step 4: Run, confirm pass**

```bash
cd gateway && bun run test ./src/hermes-adapter-client/ws-frames.test.ts 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 5: No commit yet** — phase commit at end of Phase B.

---

### Task B.2: Per-profile WS connection state machine

**Why:** One profile process gets one WS. State machine: `idle → connecting → connected → reconnecting → connected | closed`. Owns reconnect, hello/ack handshake, frame parse, and an outbound queue keyed on user-message seq.

**Files:**
- Create: `gateway/src/hermes-adapter-client/per-profile-connection.ts`
- Create: `gateway/src/hermes-adapter-client/per-profile-connection.test.ts`

- [ ] **Step 1: Write the failing FSM test**

```ts
// gateway/src/hermes-adapter-client/per-profile-connection.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPerProfileConnection } from "./per-profile-connection.ts";
import type { ConnectionEvents } from "./per-profile-connection.ts";

class MockWS {
  static instances: MockWS[] = [];
  url: string;
  readyState: number = 0; // 0=connecting, 1=open, 2=closing, 3=closed
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: "test" }); }
  // helpers used by tests
  open() { this.readyState = 1; this.onopen?.(); }
  recv(payload: object) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

describe("per-profile-connection", () => {
  beforeEach(() => { MockWS.instances = []; });
  afterEach(() => { vi.useRealTimers(); });

  it("state goes connecting → connected after hello.ack", async () => {
    const events: string[] = [];
    const conn = createPerProfileConnection({
      url: "ws://x/ws",
      token: "tok",
      wsFactory: (url) => new MockWS(url) as unknown as WebSocket,
      onEvent: (e) => events.push(e.kind),
    });
    conn.open();
    expect(conn.state()).toBe("connecting");
    const ws = MockWS.instances[0]!;
    ws.open();
    // hello sent first
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "hello", version: "1.0" });
    ws.recv({ type: "hello.ack", seq: 1, version: "1.0", server: "test" });
    expect(conn.state()).toBe("connected");
    expect(events).toContain("connected");
  });

  it("emits assistant.message events and rejects pre-hello frames", async () => {
    const events: ConnectionEvents[] = [];
    const conn = createPerProfileConnection({
      url: "ws://x/ws", token: "tok",
      wsFactory: (u) => new MockWS(u) as unknown as WebSocket,
      onEvent: (e) => events.push(e),
    });
    conn.open();
    const ws = MockWS.instances[0]!;
    ws.open();
    ws.recv({ type: "hello.ack", seq: 1, version: "1.0", server: "test" });
    ws.recv({ type: "assistant.message", seq: 2, ref: 1, text: "hi" });
    expect(events.find(e => e.kind === "assistant-message")).toBeTruthy();
  });

  it("transitions to reconnecting when WS closes mid-session", async () => {
    vi.useFakeTimers();
    const conn = createPerProfileConnection({
      url: "ws://x/ws", token: "tok",
      wsFactory: (u) => new MockWS(u) as unknown as WebSocket,
      onEvent: () => {},
      reconnectMinMs: 250,
      reconnectMaxMs: 4000,
    });
    conn.open();
    const ws = MockWS.instances[0]!;
    ws.open();
    ws.recv({ type: "hello.ack", seq: 1, version: "1.0", server: "test" });
    expect(conn.state()).toBe("connected");
    ws.close(1006);
    expect(conn.state()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(300);
    expect(MockWS.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("send() before connected throws / rejects", () => {
    const conn = createPerProfileConnection({
      url: "ws://x/ws", token: "tok",
      wsFactory: (u) => new MockWS(u) as unknown as WebSocket,
      onEvent: () => {},
    });
    expect(() => conn.sendUserMessage({ text: "hi" })).toThrow();
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
cd gateway && bun run test ./src/hermes-adapter-client/per-profile-connection.test.ts 2>&1 | tail -15
```

Expected: file-not-found / import errors.

- [ ] **Step 3: Implement**

```ts
// gateway/src/hermes-adapter-client/per-profile-connection.ts
import { getLog } from "../logging/logger.js";
import { parseFrame, type AnyFrame, type OutboundFrame } from "./ws-frames.js";

const log = getLog(["sentient", "hermes-adapter-client", "per-profile"]);

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export type ConnectionEvents =
  | { kind: "connected" }
  | { kind: "disconnected"; code: number; reason: string }
  | { kind: "assistant-message"; ref: number | null; text: string }
  | { kind: "assistant-error"; ref: number | null; reason: string }
  | { kind: "tool-start"; ref: number | null; toolCallId: string; name: string; argsSummary: string }
  | { kind: "tool-progress"; ref: number | null; toolCallId: string; message: string }
  | { kind: "tool-end"; ref: number | null; toolCallId: string; status: "ok" | "error"; resultSummary: string };

export interface PerProfileConnectionConfig {
  url: string;
  token: string;
  wsFactory?: (url: string) => WebSocket;
  onEvent: (e: ConnectionEvents) => void;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export interface PerProfileConnection {
  open(): void;
  close(): void;
  state(): ConnectionState;
  sendUserMessage(input: { text: string; internal?: boolean }): number; // returns seq
  cancelUserMessage(refSeq: number): void;
}

export function createPerProfileConnection(cfg: PerProfileConnectionConfig): PerProfileConnection {
  const factory = cfg.wsFactory ?? ((url: string) => new WebSocket(url));
  const minMs = cfg.reconnectMinMs ?? 250;
  const maxMs = cfg.reconnectMaxMs ?? 4_000;

  let state: ConnectionState = "idle";
  let ws: WebSocket | null = null;
  let outSeq = 0;
  let helloAcked = false;
  let backoffMs = minMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setState(next: ConnectionState): void {
    if (state === next) return;
    log.info("state-change", { from: state, to: next });
    state = next;
  }

  function send(frame: OutboundFrame): void {
    if (!ws || ws.readyState !== 1) {
      throw new Error(`cannot send: ws not open (state=${state})`);
    }
    ws.send(JSON.stringify(frame));
  }

  function attach(socket: WebSocket): void {
    ws = socket;
    socket.onopen = () => {
      log.debug("ws-open");
      send({ type: "hello", version: "1.0", client: "sentient-bun" });
    };
    socket.onmessage = (ev) => {
      let raw: unknown;
      try { raw = JSON.parse(typeof ev.data === "string" ? ev.data : ""); }
      catch { log.warn("malformed-json"); return; }
      const r = parseFrame(raw);
      if (!r.ok) { log.warn("frame-parse-failed", { reason: r.error.reason }); return; }
      handleFrame(r.value);
    };
    socket.onclose = (ev) => {
      log.info("ws-close", { code: ev.code, reason: ev.reason });
      cfg.onEvent({ kind: "disconnected", code: ev.code, reason: ev.reason });
      ws = null;
      helloAcked = false;
      if (state !== "closed") {
        setState("reconnecting");
        scheduleReconnect();
      }
    };
    socket.onerror = (e) => log.warn("ws-error", { error: String(e) });
  }

  function handleFrame(f: AnyFrame): void {
    if (f.type === "hello.ack") {
      helloAcked = true;
      backoffMs = minMs;
      setState("connected");
      cfg.onEvent({ kind: "connected" });
      return;
    }
    if (!helloAcked) return; // ignore until handshake done
    switch (f.type) {
      case "assistant.message": cfg.onEvent({ kind: "assistant-message", ref: f.ref, text: f.text }); return;
      case "assistant.error":   cfg.onEvent({ kind: "assistant-error", ref: f.ref, reason: f.reason }); return;
      case "tool.start":        cfg.onEvent({ kind: "tool-start", ref: f.ref, toolCallId: f.tool_call_id, name: f.name, argsSummary: f.args_summary }); return;
      case "tool.progress":     cfg.onEvent({ kind: "tool-progress", ref: f.ref, toolCallId: f.tool_call_id, message: f.message }); return;
      case "tool.end":          cfg.onEvent({ kind: "tool-end", ref: f.ref, toolCallId: f.tool_call_id, status: f.status, resultSummary: f.result_summary }); return;
      case "pong":              return;
    }
  }

  function scheduleReconnect(): void {
    if (state === "closed") return;
    const delay = backoffMs;
    backoffMs = Math.min(maxMs, backoffMs * 2 + Math.floor(Math.random() * 100));
    reconnectTimer = setTimeout(() => attemptOpen(), delay);
  }

  function attemptOpen(): void {
    setState("connecting");
    helloAcked = false;
    const url = appendAuthHeaderViaSubprotocol(cfg.url, cfg.token);
    const socket = factory(url);
    attach(socket);
  }

  return {
    open(): void {
      if (state !== "idle" && state !== "closed") return;
      attemptOpen();
    },
    close(): void {
      setState("closed");
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      ws?.close(1000);
    },
    state(): ConnectionState { return state; },
    sendUserMessage(input): number {
      outSeq += 1;
      const frame: OutboundFrame = { type: "user.message", seq: outSeq, text: input.text, internal: input.internal };
      send(frame);
      return outSeq;
    },
    cancelUserMessage(refSeq: number): void {
      outSeq += 1;
      send({ type: "user.cancel", seq: outSeq, ref: refSeq });
    },
  };
}

// Browsers reject WebSocket() with custom headers; Bun's WebSocket API
// supports them. We pass the bearer via Authorization-style query when on
// browser-shaped runtimes; on Bun we pass via the supported `headers`
// option. The implementation here uses Bun's WebSocket which honors
// `headers` on construction; the wsFactory abstraction lets tests inject
// a mock that ignores the URL transformation.
function appendAuthHeaderViaSubprotocol(url: string, _token: string): string {
  // Bun's `new WebSocket(url, {headers: {...}})` is used in the production
  // factory below this module. The URL is unchanged here; the production
  // factory closes over the token. Tests inject their own factory so
  // this URL transform is a no-op for them.
  return url;
}
```

> The `wsFactory` injection point is the seam for production code (which uses Bun's `new WebSocket(url, { headers: { Authorization: "Bearer ..." } })`). Production factory lives in the next task's connection-pool module.

- [ ] **Step 4: Run, confirm pass**

```bash
cd gateway && bun run test ./src/hermes-adapter-client/per-profile-connection.test.ts 2>&1 | tail -10
```

Expected: all green.

- [ ] **Step 5: No commit yet.**

---

### Task B.3: Connection pool

**Why:** N profile processes = N connections; lookup by userId. The pool also owns the production WS factory (Bun's `new WebSocket(url, { headers })`).

**Files:**
- Create: `gateway/src/hermes-adapter-client/connection-pool.ts`
- Create: `gateway/src/hermes-adapter-client/connection-pool.test.ts`

- [ ] **Step 1: Test (FSM-level)**

```ts
// gateway/src/hermes-adapter-client/connection-pool.test.ts
import { describe, expect, it, vi } from "vitest";
import { createConnectionPool, type PoolDeps } from "./connection-pool.ts";

describe("connection-pool", () => {
  it("upserts a profile by userId, dedups", () => {
    const created: string[] = [];
    const deps: PoolDeps = {
      makeConnection: (cfg) => {
        created.push(cfg.url);
        return { open: vi.fn(), close: vi.fn(), state: () => "connected" as const, sendUserMessage: vi.fn(() => 1), cancelUserMessage: vi.fn() };
      },
    };
    const pool = createConnectionPool(deps);
    pool.upsert({ userId: "u_alice", url: "ws://h/ws", token: "t1" });
    pool.upsert({ userId: "u_alice", url: "ws://h/ws", token: "t1" }); // dedup
    pool.upsert({ userId: "u_bob",   url: "ws://h2/ws", token: "t2" });
    expect(created).toEqual(["ws://h/ws", "ws://h2/ws"]);
  });

  it("removes by userId", () => {
    const closed: string[] = [];
    const deps: PoolDeps = {
      makeConnection: (cfg) => {
        return { open: vi.fn(), close: () => closed.push(cfg.url), state: () => "connected" as const, sendUserMessage: vi.fn(() => 1), cancelUserMessage: vi.fn() };
      },
    };
    const pool = createConnectionPool(deps);
    pool.upsert({ userId: "u_alice", url: "ws://h/ws", token: "t1" });
    pool.remove("u_alice");
    expect(closed).toEqual(["ws://h/ws"]);
    expect(pool.get("u_alice")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

```bash
cd gateway && bun run test ./src/hermes-adapter-client/connection-pool.test.ts 2>&1 | tail -8
```

- [ ] **Step 3: Implement**

```ts
// gateway/src/hermes-adapter-client/connection-pool.ts
import { getLog } from "../logging/logger.js";
import { createPerProfileConnection, type ConnectionEvents, type PerProfileConnection } from "./per-profile-connection.js";

const log = getLog(["sentient", "hermes-adapter-client", "pool"]);

export interface UpsertProfileInput {
  userId: string;
  url: string;
  token: string;
  onEvent?: (e: ConnectionEvents) => void;
}

export interface PoolDeps {
  makeConnection: (cfg: { url: string; token: string; onEvent: (e: ConnectionEvents) => void }) => PerProfileConnection;
}

export interface ConnectionPool {
  upsert(input: UpsertProfileInput): PerProfileConnection;
  remove(userId: string): void;
  get(userId: string): PerProfileConnection | null;
  closeAll(): void;
}

interface Entry {
  url: string;
  token: string;
  conn: PerProfileConnection;
}

export function createConnectionPool(deps: PoolDeps): ConnectionPool {
  const byUserId = new Map<string, Entry>();
  return {
    upsert(input): PerProfileConnection {
      const existing = byUserId.get(input.userId);
      if (existing && existing.url === input.url && existing.token === input.token) {
        return existing.conn;
      }
      if (existing) {
        log.info("upsert-replace", { userId: input.userId });
        existing.conn.close();
      }
      const conn = deps.makeConnection({
        url: input.url,
        token: input.token,
        onEvent: input.onEvent ?? (() => {}),
      });
      conn.open();
      byUserId.set(input.userId, { url: input.url, token: input.token, conn });
      return conn;
    },
    remove(userId): void {
      const e = byUserId.get(userId);
      if (!e) return;
      e.conn.close();
      byUserId.delete(userId);
    },
    get(userId): PerProfileConnection | null {
      return byUserId.get(userId)?.conn ?? null;
    },
    closeAll(): void {
      for (const [uid, e] of byUserId) {
        log.debug("close", { userId: uid });
        e.conn.close();
      }
      byUserId.clear();
    },
  };
}

// Production factory used by bootstrap. Bun's WebSocket honors `headers`.
export function defaultMakeConnection(input: { url: string; token: string; onEvent: (e: ConnectionEvents) => void }): PerProfileConnection {
  return createPerProfileConnection({
    url: input.url,
    token: input.token,
    onEvent: input.onEvent,
    wsFactory: (url) =>
      // Bun-specific: headers in WebSocket constructor options
      new WebSocket(url, {
        headers: { Authorization: `Bearer ${input.token}` },
      } as unknown as undefined),
  });
}
```

- [ ] **Step 4: Run, confirm pass.**

```bash
cd gateway && bun run test ./src/hermes-adapter-client/connection-pool.test.ts 2>&1 | tail -6
```

- [ ] **Step 5: No commit yet.**

---

### Task B.4: Frame → cerebrum event translator

**Why:** The cerebrum and webui already consume `HermesEvent` (defined in `gateway/src/cerebrum/hermes-event-types.ts`). To avoid touching every consumer, the translator maps WS frames to existing `HermesEvent` shapes (assistant text → token-delta event for the streaming typewriter; tool.start/end → existing tool-progress shape).

**Files:**
- Create: `gateway/src/hermes-adapter-client/event-translator.ts`
- Create: `gateway/src/hermes-adapter-client/event-translator.test.ts`

- [ ] **Step 1: Read existing `HermesEvent` shape**

```bash
sed -n '1,80p' gateway/src/cerebrum/hermes-event-types.ts
```

Capture exact event names + payload shapes used by `hermes-event-translator.ts` and `hermes-dispatcher.ts`. Notes go to scratch — every translator output must conform.

- [ ] **Step 2: Test the translator with concrete frame → event mappings**

```ts
// gateway/src/hermes-adapter-client/event-translator.test.ts
import { describe, expect, it } from "vitest";
import { translateConnectionEventToHermesEvent } from "./event-translator.ts";
import type { ConnectionEvents } from "./per-profile-connection.ts";

describe("translateConnectionEventToHermesEvent", () => {
  it("maps assistant-message to a content-delta-then-completed pair (since adapter is non-streaming v1)", () => {
    const e: ConnectionEvents = { kind: "assistant-message", ref: 1, text: "Hello there" };
    const out = translateConnectionEventToHermesEvent(e, { cycleId: "c1" });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]?.kind).toBe("content-delta");
    expect(out.at(-1)?.kind).toBe("response-completed");
  });

  it("maps tool-start to tool-call-started", () => {
    const e: ConnectionEvents = { kind: "tool-start", ref: 1, toolCallId: "c1", name: "web_search", argsSummary: "q=foo" };
    const out = translateConnectionEventToHermesEvent(e, { cycleId: "c1" });
    expect(out[0]?.kind).toBe("tool-call-started");
  });

  it("maps tool-end ok to tool-call-completed", () => {
    const e: ConnectionEvents = { kind: "tool-end", ref: 1, toolCallId: "c1", status: "ok", resultSummary: "..." };
    const out = translateConnectionEventToHermesEvent(e, { cycleId: "c1" });
    expect(out[0]?.kind).toBe("tool-call-completed");
  });
});
```

- [ ] **Step 3: Implement**

```ts
// gateway/src/hermes-adapter-client/event-translator.ts
import type { HermesEvent } from "../cerebrum/hermes-event-types.js";
import type { ConnectionEvents } from "./per-profile-connection.js";

export interface TranslateContext {
  cycleId: string;
}

/**
 * Map a single WS connection event to zero-or-more HermesEvent values
 * the cerebrum already consumes. v1 is non-streaming — assistant.message
 * becomes a single (content-delta, response-completed) pair so the
 * cerebrum's existing streaming typewriter / TTS aggregator path runs
 * unchanged.
 */
export function translateConnectionEventToHermesEvent(
  e: ConnectionEvents,
  ctx: TranslateContext,
): HermesEvent[] {
  switch (e.kind) {
    case "connected":
    case "disconnected":
      return [];
    case "assistant-message":
      return [
        { kind: "content-delta", cycleId: ctx.cycleId, delta: e.text },
        { kind: "response-completed", cycleId: ctx.cycleId },
      ];
    case "assistant-error":
      return [{ kind: "response-error", cycleId: ctx.cycleId, reason: e.reason }];
    case "tool-start":
      return [{
        kind: "tool-call-started",
        cycleId: ctx.cycleId,
        toolCallId: e.toolCallId,
        name: e.name,
        argsSummary: e.argsSummary,
      }];
    case "tool-progress":
      return [{
        kind: "tool-call-progress",
        cycleId: ctx.cycleId,
        toolCallId: e.toolCallId,
        message: e.message,
      }];
    case "tool-end":
      return [{
        kind: "tool-call-completed",
        cycleId: ctx.cycleId,
        toolCallId: e.toolCallId,
        status: e.status,
        resultSummary: e.resultSummary,
      }];
  }
}
```

> **If `HermesEvent` lacks any of `tool-call-progress` / `response-completed` / `response-error` exactly as named, surface a discrepancy** rather than inventing — the translator's job is to match what the cerebrum already consumes. Likely candidates per current cerebrum naming: check `hermes-event-types.ts` and adjust string literals here to match. Do NOT change cerebrum types.

- [ ] **Step 4: Run, confirm pass (after adjusting to match real types)**

```bash
cd gateway && bun run test ./src/hermes-adapter-client/event-translator.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: No commit yet.**

---

### Task B.5: New `WsHermesClient` implementation of `HermesClient` interface

**Why:** The cerebrum (`hermes-dispatcher.ts`, `session-router.ts`) consumes the `HermesClient` interface. We provide a new implementation that uses the connection pool + translator under the hood.

**Files:**
- Create: `gateway/src/hermes-adapter-client/ws-hermes-client.ts`
- Modify: `gateway/src/cerebrum/hermes-client.ts` (delete `HttpHermesClient` + SSE helpers, keep interface)
- Modify: `gateway/src/bootstrap/create-gateway-services.ts` (swap impl)
- Modify: `gateway/src/cerebrum/sse-parser.ts` — DELETE (unused after swap)

- [ ] **Step 1: Read the existing `HermesClient` interface**

```bash
sed -n '1,60p' gateway/src/cerebrum/hermes-client.ts
grep -rn "HttpHermesClient\|new HttpHermesClient\|hermes-client" gateway/src/ --include="*.ts" | grep -v test
```

Capture: interface methods, return types, call sites. Discrepancies between assumed and actual = `NEEDS_CONTEXT`.

- [ ] **Step 2: Implement `WsHermesClient`**

The class implements `HermesClient.dispatch(input)` → `AsyncGenerator<HermesEvent>`. Internals:
1. Look up the per-profile connection in the pool (by `input.profileBinding.userId`).
2. Subscribe to a single-cycle event stream via the connection's onEvent callback.
3. Send `user.message` frame; capture returned outSeq.
4. As `ConnectionEvents` arrive whose `ref === outSeq`, translate via `translateConnectionEventToHermesEvent` and yield each.
5. On `response-completed` or `response-error`, finalize the generator.
6. On `dispatch.cancel()` (from cerebrum), call `cancelUserMessage(outSeq)`.

```ts
// gateway/src/hermes-adapter-client/ws-hermes-client.ts
import type { Result } from "@sentient/protocol";
import type { HermesClient, HermesProfileBinding, HermesTurnInput } from "../cerebrum/hermes-client.js";
import type { HermesEvent } from "../cerebrum/hermes-event-types.js";
import { getLog } from "../logging/logger.js";
import type { ConnectionPool } from "./connection-pool.js";
import { translateConnectionEventToHermesEvent } from "./event-translator.js";

const log = getLog(["sentient", "hermes-adapter-client", "ws-hermes-client"]);

export interface WsHermesClientDeps {
  pool: ConnectionPool;
}

export function createWsHermesClient(deps: WsHermesClientDeps): HermesClient {
  return {
    async *dispatch(input: HermesTurnInput): AsyncGenerator<HermesEvent> {
      const userId = input.profileBinding.userId;
      const conn = deps.pool.get(userId);
      if (!conn) {
        yield { kind: "response-error", cycleId: input.cycleId, reason: `no connection for userId=${userId}` };
        return;
      }
      const queue: HermesEvent[] = [];
      let resolver: (() => void) | null = null;
      let finished = false;

      const outSeq = conn.sendUserMessage({ text: input.userText, internal: input.internal });

      // Subscribe by re-binding onEvent on the underlying conn — production
      // pool binds onEvent when upserting; the cerebrum's dispatch should
      // call into a shared event router. The simplest v1 wiring routes
      // events here through a per-cycle subscriber registered in the pool
      // wiring (see Task B.6 — bootstrap glue).
      // For testability, this method receives events via the
      // input.events iterator (pre-bound by bootstrap).
      for await (const evt of input.events) {
        if (evt.ref !== outSeq) continue;
        const out = translateConnectionEventToHermesEvent(evt, { cycleId: input.cycleId });
        for (const h of out) yield h;
        if (out.some(e => e.kind === "response-completed" || e.kind === "response-error")) {
          finished = true;
          break;
        }
      }
    },
  };
}
```

> The exact subscription wiring (how `input.events` flows in) depends on how `HermesClient.dispatch` is currently invoked from the cerebrum. Read `hermes-dispatcher.ts` carefully and adapt — keep the public contract identical.

- [ ] **Step 3: Update `gateway/src/cerebrum/hermes-client.ts` — keep interface, delete HttpHermesClient + SSE helpers**

Show the resulting file (truncated to interfaces only):

```ts
// gateway/src/cerebrum/hermes-client.ts
import type { DispatchMode, HermesEvent, HermesTurnInput } from "./hermes-event-types.js";

export interface HermesProfileBinding {
  // existing fields preserved
}

export interface HermesClient {
  dispatch(input: HermesTurnInput): AsyncGenerator<HermesEvent>;
}
```

Delete: `HttpHermesClient` class, `translateSse` helper, all imports of `parseSseStream` / `zod`.

- [ ] **Step 4: Delete `sse-parser.ts`**

```bash
rm gateway/src/cerebrum/sse-parser.ts gateway/src/cerebrum/sse-parser.test.ts 2>/dev/null
git add -A gateway/src/cerebrum/sse-parser.ts gateway/src/cerebrum/sse-parser.test.ts
```

(`git add -A` for deletions.)

- [ ] **Step 5: Update `bootstrap/create-gateway-services.ts`**

Replace the `new HttpHermesClient(...)` line with construction of the connection pool + `createWsHermesClient`. Read the current bootstrap (`grep -n "HermesClient\|HttpHermesClient" gateway/src/bootstrap/create-gateway-services.ts`) to find the exact insertion site, then swap.

- [ ] **Step 6: Run all gateway tests**

```bash
docker ps --filter name=sentient- --format '{{.Names}}' # ensure none running
cd gateway && bun run test 2>&1 | tail -5
```

Expected: 0 failures. If failures appear in cerebrum tests due to deleted helpers, surface and address per test-lean doctrine (likely those tests test deleted code → delete the tests too).

- [ ] **Step 7: No commit yet.**

---

### Task B.6: Live smoke against the Phase A overlay image

**Why:** Confirm the full Bun-side path actually works against a real Hermes process.

- [ ] **Step 1: Boot Phase A's overlay container with a single profile**

(Same staging as Task A.9, Step 1 + 2.)

- [ ] **Step 2: Wire the gateway against the probe**

Add a temporary scratch script `/tmp/sentient-bun-probe.ts`:

```ts
// /tmp/sentient-bun-probe.ts
import { createConnectionPool, defaultMakeConnection } from "/Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter/gateway/src/hermes-adapter-client/connection-pool.ts";

const pool = createConnectionPool({ makeConnection: defaultMakeConnection });
pool.upsert({
  userId: "u_probe",
  url: "ws://127.0.0.1:18650/ws",
  token: "probe-token-aaaa-bbbb",
  onEvent: (e) => console.log("EVT", e),
});
setTimeout(() => process.exit(0), 5000);
```

```bash
bun /tmp/sentient-bun-probe.ts 2>&1 | head -20
```

Expected: `EVT { kind: "connected" }` within ~1s.

- [ ] **Step 3: Tear down**

```bash
docker rm -f hermes-probe
rm /tmp/sentient-bun-probe.ts
```

---

### Task B.7: Phase B commit

```bash
git status -s
git add gateway/src/hermes-adapter-client/ gateway/src/cerebrum/hermes-client.ts gateway/src/bootstrap/create-gateway-services.ts
git rm gateway/src/cerebrum/sse-parser.ts gateway/src/cerebrum/sse-parser.test.ts 2>/dev/null || true
git commit -m "feat(gateway): replace HTTP+SSE Hermes client with WS adapter client" -m "$(cat <<'EOF'
gateway/src/hermes-adapter-client/ defines:
  ws-frames           zod schemas + parse for the platform-adapter contract
  per-profile-connection  state machine: idle->connecting->connected->reconnecting
  connection-pool     N profile WS connections, lookup by userId
  event-translator    WS frames -> existing HermesEvent shape (no cerebrum changes)
  ws-hermes-client    new HermesClient impl over the pool

Deletes HttpHermesClient + SSE parser; preserves the HermesClient interface
so cerebrum/dispatcher consumers remain unchanged. Bootstrap swaps the impl.

Verified: connection-pool + per-profile FSM unit tests pass; live smoke
against the Phase A overlay image (one profile) shows the connection
event firing and frames flowing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C — supervisord control + per-profile lifecycle

The phase replaces the docker-engine-driven reconciler with a supervisord-driven one. After this phase, `user-provisioner.createUser` writes a supervisord program for the new user; `user-provisioner.deleteUser` removes it; `apply/orchestrator.runApply` restarts a single profile's process. `gateway/src/admin/hermes-pool-reconciler.ts` is **not yet deleted** — Phase H retires it once we've proven the new path on the live stack.

### Task C.1: Supervisord program template

**Files:**
- Create: `gateway/src/profile-store/supervisord-program.tmpl`

- [ ] **Step 1: Write template**

```ini
; /data/supervisor/programs/{{userId}}.conf — rendered by gateway
[program:hermes-{{userId}}]
command=hermes -p {{userId}} gateway run
autostart=true
autorestart=true
startretries=5
stopwaitsecs=10
stderr_logfile=/data/profiles/{{userId}}/supervisord.err.log
stdout_logfile=/data/profiles/{{userId}}/supervisord.out.log
environment=
  HERMES_HOME="/data/profiles/{{userId}}",
  SENTIENT_GATEWAY_TOKEN="{{token}}",
  SENTIENT_GATEWAY_PORT="{{port}}",
  SENTIENT_GATEWAY_ALLOW_ALL_USERS="true",
  GATEWAY_ALLOW_ALL_USERS="true",
  TZ="{{timezone}}"
```

The template uses `{{var}}` for substitution; renderer is a tiny string replace, not a full mustache implementation (no nesting needed).

---

### Task C.2: `supervisord-control.ts`

**Why:** One module owns all supervisord interaction. Encapsulates the unix-socket path, `supervisorctl` invocation, and program rendering + reread/update orchestration.

**Files:**
- Create: `gateway/src/admin/supervisord-control.ts`
- Create: `gateway/src/admin/supervisord-control.test.ts`

- [ ] **Step 1: Test (FSM/contract)**

```ts
// gateway/src/admin/supervisord-control.test.ts
import { describe, expect, it, vi } from "vitest";
import { createSupervisordControl } from "./supervisord-control.ts";

describe("supervisord-control", () => {
  it("renders program, calls reread+update, returns ok", async () => {
    const calls: string[] = [];
    const ctrl = createSupervisordControl({
      programsDir: "/tmp/test-progs",
      template: "[program:hermes-{{userId}}] port={{port}} token={{token}}",
      shell: async (cmd) => { calls.push(cmd); return { ok: true, value: "" }; },
      writeFile: async () => { calls.push("writeFile"); },
    });
    const r = await ctrl.upsertProgram({ userId: "u_a", port: 8643, token: "t", timezone: "UTC" });
    expect(r.ok).toBe(true);
    expect(calls).toContain("supervisorctl reread");
    expect(calls).toContain("supervisorctl update");
  });

  it("restartProfile issues supervisorctl restart hermes-<userId>", async () => {
    const ran: string[] = [];
    const ctrl = createSupervisordControl({
      programsDir: "/tmp",
      template: "x",
      shell: async (cmd) => { ran.push(cmd); return { ok: true, value: "" }; },
      writeFile: async () => {},
    });
    const r = await ctrl.restartProfile("u_a", 30_000);
    expect(r.ok).toBe(true);
    expect(ran).toContain("supervisorctl restart hermes-u_a");
  });
});
```

- [ ] **Step 2: Implement** (~150 lines, `<300` per rule)

```ts
// gateway/src/admin/supervisord-control.ts
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "admin", "supervisord"]);

export interface SupervisordControlConfig {
  programsDir: string;            // e.g. /data/supervisor/programs
  template: string;               // contents of supervisord-program.tmpl
  shell?: (cmd: string) => Promise<Result<string, { kind: string; reason: string }>>;
  writeFile?: (path: string, content: string) => Promise<void>;
  unlinkFile?: (path: string) => Promise<void>;
}

export interface UpsertInput {
  userId: string;
  port: number;
  token: string;
  timezone: string;
}

export type SupervisordError = { kind: "shell-failed" | "io-failed"; reason: string };

export interface SupervisordControl {
  upsertProgram(input: UpsertInput): Promise<Result<void, SupervisordError>>;
  removeProgram(userId: string): Promise<Result<void, SupervisordError>>;
  restartProfile(userId: string, timeoutMs: number): Promise<Result<void, SupervisordError>>;
  status(userId: string): Promise<Result<{ running: boolean; pid: number | null }, SupervisordError>>;
}

export function createSupervisordControl(cfg: SupervisordControlConfig): SupervisordControl {
  const sh = cfg.shell ?? defaultShell;
  const wf = cfg.writeFile ?? writeFile;
  const ul = cfg.unlinkFile ?? unlink;

  function render(input: UpsertInput): string {
    return cfg.template
      .replaceAll("{{userId}}", input.userId)
      .replaceAll("{{port}}", String(input.port))
      .replaceAll("{{token}}", input.token)
      .replaceAll("{{timezone}}", input.timezone);
  }

  function programPath(userId: string): string {
    return join(cfg.programsDir, `${userId}.conf`);
  }

  return {
    async upsertProgram(input): Promise<Result<void, SupervisordError>> {
      try {
        await wf(programPath(input.userId), render(input));
      } catch (err: unknown) {
        return { ok: false, error: { kind: "io-failed", reason: String(err) } };
      }
      const reread = await sh("supervisorctl reread");
      if (!reread.ok) return { ok: false, error: { kind: "shell-failed", reason: reread.error.reason } };
      const update = await sh("supervisorctl update");
      if (!update.ok) return { ok: false, error: { kind: "shell-failed", reason: update.error.reason } };
      log.info("upsertProgram", { userId: input.userId, port: input.port });
      return { ok: true, value: undefined };
    },
    async removeProgram(userId): Promise<Result<void, SupervisordError>> {
      const stop = await sh(`supervisorctl stop hermes-${userId}`);
      // OK if already stopped — supervisorctl returns non-zero; ignore.
      try { await ul(programPath(userId)); }
      catch (err: unknown) { return { ok: false, error: { kind: "io-failed", reason: String(err) } }; }
      const reread = await sh("supervisorctl reread");
      const update = await sh("supervisorctl update");
      if (!reread.ok || !update.ok) {
        return { ok: false, error: { kind: "shell-failed", reason: "reread/update failed after remove" } };
      }
      log.info("removeProgram", { userId });
      return { ok: true, value: undefined };
    },
    async restartProfile(userId, _timeoutMs): Promise<Result<void, SupervisordError>> {
      const r = await sh(`supervisorctl restart hermes-${userId}`);
      if (!r.ok) return { ok: false, error: { kind: "shell-failed", reason: r.error.reason } };
      return { ok: true, value: undefined };
    },
    async status(userId): Promise<Result<{ running: boolean; pid: number | null }, SupervisordError>> {
      const r = await sh(`supervisorctl status hermes-${userId}`);
      if (!r.ok) return { ok: false, error: { kind: "shell-failed", reason: r.error.reason } };
      const out = r.value;
      const running = /RUNNING\s+pid\s+(\d+)/.exec(out);
      return { ok: true, value: { running: !!running, pid: running ? Number(running[1]) : null } };
    },
  };
}

async function defaultShell(cmd: string): Promise<Result<string, { kind: string; reason: string }>> {
  const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (code !== 0) {
    return { ok: false, error: { kind: "exit-non-zero", reason: stderr.slice(0, 120) || stdout.slice(0, 120) } };
  }
  return { ok: true, value: stdout };
}
```

- [ ] **Step 3: Run, confirm green.**

```bash
cd gateway && bun run test ./src/admin/supervisord-control.test.ts 2>&1 | tail -8
```

- [ ] **Step 4: No commit yet.**

---

### Task C.3: Wire `user-provisioner.ts` to use `supervisord-control` + extend `slot-binding-store` with `port`

**Files:**
- Modify: `gateway/src/admin/slot-binding-store.ts` (add `port` field to bindings)
- Modify: `gateway/src/admin/slot-allocator.ts` (assign port; use `8650 + slot index`)
- Modify: `gateway/src/admin/user-provisioner.ts` (replace `reconcileSlot` injection with `supervisordControl` + new flow)
- Modify: `gateway/src/admin/user-provisioner.test.ts` (update mocks)

- [ ] **Step 1: Read current shape**

```bash
sed -n '1,80p' gateway/src/admin/slot-binding-store.ts
sed -n '1,60p' gateway/src/admin/slot-allocator.ts
```

- [ ] **Step 2: Add `port: number` to the binding type, default `8650 + index`. Migration on read: bindings without `port` get `8650 + indexInList` assigned and re-saved.**

- [ ] **Step 3: Replace `reconcileSlot` dependency with `supervisordControl: Pick<SupervisordControl, "upsertProgram" | "removeProgram">` + `internalSecrets` (read token).**

`createUser` flow:
1. allocate slot → has `slotKey`, `port`
2. write profile dir + config + SOUL via existing `profile-renderer.ts`
3. call `supervisordControl.upsertProgram({ userId, port, token, timezone })`
4. if any step fails, roll back in reverse order

`deleteUser` flow:
1. call `supervisordControl.removeProgram(userId)` (best-effort)
2. archive user dir
3. release slot

- [ ] **Step 4: Update tests to mock `supervisordControl` instead of `reconcileSlot`. Tests stay focused on the FSM (allocate-write-program-success vs partial failure rollbacks).**

- [ ] **Step 5: Run, confirm green.**

```bash
cd gateway && bun run test ./src/admin/ 2>&1 | tail -10
```

- [ ] **Step 6: No commit yet.**

---

### Task C.4: Wire `apply/orchestrator.ts` to use `supervisord-control.restartProfile`

**Files:**
- Modify: `gateway/src/apply/orchestrator.ts`
- Modify: `gateway/src/apply/apply-deps.ts`
- Modify: tests

- [ ] **Step 1: Read current `runApply` flow + the `reconcileSlotForApply` injection point.**

```bash
sed -n '1,127p' gateway/src/apply/orchestrator.ts
```

- [ ] **Step 2: Replace `reconcileSlotForApply` with `restartProfile(userId, timeoutMs)` from `SupervisordControl`. Error mapping `shell-failed → docker-restart-failed` (rename later or keep error name for stability — surface and decide).**

- [ ] **Step 3: Update tests + run.**

```bash
cd gateway && bun run test ./src/apply/ 2>&1 | tail -8
```

- [ ] **Step 4: No commit yet.**

---

### Task C.5: Verify supervisord socket cross-container — POC

**Why:** The Bun gateway container needs to issue `supervisorctl` against the `sentient-hermes` container's supervisord. Cross-container Unix-socket bind-mount is the cleanest answer; verify before committing to the Phase F compose changes.

- [ ] **Step 1: Run two short-lived containers sharing a tmpfs**

```bash
mkdir -p /tmp/sentient-supervisor-poc/sock
docker run -d --name sup-poc-server \
  -v /tmp/sentient-supervisor-poc:/data \
  python:3.13-slim sh -c '
    pip install supervisor >/dev/null
    cat > /etc/supervisord.conf <<EOF
[supervisord]
nodaemon=true
[unix_http_server]
file=/data/sock/supervisor.sock
chmod=0700
[supervisorctl]
serverurl=unix:///data/sock/supervisor.sock
[rpcinterface:supervisor]
supervisor.rpcinterface_factory=supervisor.rpcinterface.make_main_rpcinterface
EOF
    supervisord -c /etc/supervisord.conf
  '
sleep 4
docker run --rm \
  -v /tmp/sentient-supervisor-poc:/data \
  python:3.13-slim sh -c '
    pip install supervisor >/dev/null
    supervisorctl -s unix:///data/sock/supervisor.sock status
    echo "exit=$?"
  '
```

Expected: `supervisorctl` from the second container connects and prints status (or "no such service" — both indicate the socket is reachable).

If the socket is reachable but auth-rejected (default `chmod=0700` + uid mismatch): change to `chmod=0770` and ensure both containers run with the same user/uid via `--user` or `USER` directive in the gateway Dockerfile.

- [ ] **Step 2: Tear down**

```bash
docker rm -f sup-poc-server
rm -rf /tmp/sentient-supervisor-poc
```

- [ ] **Step 3: No commit (research only).**

---

### Task C.6: Boot-migration step renders programs for existing users

**Why:** First boot after Phase F: the gateway must render a supervisord program for every existing user in `users.json` so they come back up under the new model.

**Files:**
- Modify: `gateway/src/admin/boot-migration.ts`

- [ ] **Step 1: Read current boot-migration shape.**

- [ ] **Step 2: After existing migration steps, iterate `users.json` and call `supervisordControl.upsertProgram` for each. Idempotent: write same content → reread+update is a no-op for unchanged programs.**

- [ ] **Step 3: Test (FSM): if 3 users exist, 3 program files exist after boot-migration; if 0 users exist, no programs.**

- [ ] **Step 4: No commit yet.**

---

### Task C.7: Phase C commit

```bash
git add gateway/src/admin/supervisord-control.ts gateway/src/admin/supervisord-control.test.ts \
        gateway/src/admin/slot-binding-store.ts gateway/src/admin/slot-allocator.ts \
        gateway/src/admin/user-provisioner.ts gateway/src/admin/user-provisioner.test.ts \
        gateway/src/admin/boot-migration.ts \
        gateway/src/apply/orchestrator.ts gateway/src/apply/apply-deps.ts \
        gateway/src/profile-store/supervisord-program.tmpl
git commit -m "feat(gateway): supervisord-driven per-profile lifecycle" -m "$(cat <<'EOF'
New module gateway/src/admin/supervisord-control.ts wraps supervisorctl
over a bind-mounted Unix socket and renders per-user program configs
from gateway/src/profile-store/supervisord-program.tmpl.

slot-binding-store now records port (8650 + slot index). slot-allocator
assigns the port at create time; user-provisioner.createUser writes the
program; deleteUser removes it; apply.orchestrator.runApply restarts
hermes-<userId>.

boot-migration renders programs for any user in users.json that lacks one.

Cross-container socket reachability verified via a 2-container POC.

The Phase 7.5 hermes-pool-reconciler module is left in place — Phase H
retires it once the live stack proves the new path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase D — Personality + SOUL endpoints (gateway HTTP)

The phase exposes the spec-§8 endpoints. All edits are self-service; auth is "request must match authenticated user's profile" (no admin override in v1).

### Task D.1: Personality store helper — read/parse/write

**Files:**
- Create: `gateway/src/profile-store/personality-store.ts`
- Create: `gateway/src/profile-store/personality-store.test.ts`

The helper:
- reads `<userId>/config.yaml`, returns `{ personalities: [{name, body}], activeName }`
- writes a new entry (atomic)
- updates an existing entry (atomic)
- deletes an entry (atomic)
- resolves `activeName`: matches `agent.system_prompt` against each personality's resolved body (Hermes' `_resolve_prompt` algorithm: string OR `{system_prompt, tone, style}` concatenated)

- [ ] **Step 1: Test contract**

```ts
// personality-store.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonalityStore } from "./personality-store.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ps-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("personality-store", () => {
  it("reads simple-string personalities and resolves active by body match", async () => {
    writeFileSync(join(dir, "config.yaml"),
      "agent:\n  system_prompt: \"Speak warmly.\"\n  personalities:\n    warm: \"Speak warmly.\"\n    focus: \"Be terse.\"\n");
    const store = createPersonalityStore({ profileDir: dir });
    const r = await store.list();
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.personalities).toHaveLength(2);
    expect(r.value.activeName).toBe("warm");
  });

  it("resolves dict-form personality (system_prompt+tone+style)", async () => {
    writeFileSync(join(dir, "config.yaml"),
      "agent:\n  system_prompt: \"You are X\\nTone: bright\"\n  personalities:\n    x: { system_prompt: \"You are X\", tone: \"bright\" }\n");
    const r = await (await createPersonalityStore({ profileDir: dir })).list();
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.activeName).toBe("x");
  });

  it("addPersonality + getPersonality + removePersonality", async () => {
    writeFileSync(join(dir, "config.yaml"), "agent:\n  personalities: {}\n");
    const store = createPersonalityStore({ profileDir: dir });
    expect((await store.add("warm", "be warm")).ok).toBe(true);
    const list = await store.list();
    if (!list.ok) throw new Error("unreachable");
    expect(list.value.personalities[0]?.name).toBe("warm");
    expect((await store.remove("warm")).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Implement** (~150 lines, atomic writes via `fs.promises.writeFile` + rename pattern, YAML parse via `js-yaml` if already in deps; otherwise regex-edit the personalities block).

- [ ] **Step 3: Run; pass.**

- [ ] **Step 4: No commit yet.**

---

### Task D.2: HTTP endpoints — `/api/profiles/:userId/{soul,personalities,active-personality}`

**Files:**
- Create: `gateway/src/admin/profile-edit-handlers.ts` (handler factory)
- Modify: `gateway/src/server/routes.ts` (register routes)

The handler factory takes deps `{ personalityStore, soulFile, restartOrchestrator }` and produces handlers for each route. Each handler:
1. validates request matches authenticated user (or returns 403)
2. for restart-required actions: calls `restartOrchestrator.restart(userId)` after the file write; returns timing info
3. for `active-personality`: sends `/personality <name>` via the WS adapter as an `internal:true` user.message frame; returns immediately

- [ ] **Step 1: Test the active-personality flow**

```ts
// (test pseudocode — full impl mirrors patterns in existing admin handlers)
it("active-personality posts internal slash command via adapter", async () => {
  const sent: string[] = [];
  const adapter = { sendUserMessageRaw: (uid: string, t: string, internal: boolean) => sent.push(`${uid}:${t}:${internal}`) };
  const handler = createActivePersonalityHandler({ adapter });
  await handler({ userId: "u_a", body: { name: "warm" } });
  expect(sent).toContain("u_a:/personality warm:true");
});
```

- [ ] **Step 2: Implement endpoints** per spec §8 endpoint list. All return `Result<...>` mapped to HTTP via existing route adapter.

- [ ] **Step 3: Test list-personalities returns active_name correctly.**

- [ ] **Step 4: No commit yet.**

---

### Task D.3: Restart-with-spinner orchestrator

**Files:**
- Create: `gateway/src/admin/profile-restart-orchestrator.ts`
- Create: `gateway/src/admin/profile-restart-orchestrator.test.ts`

State machine: `idle → writing → closing-ws → restarting → polling → ready | failed` (≤30s total).

- [ ] **Step 1: Test the FSM**

```ts
it("happy path: writing → closing-ws → restarting → polling → ready", async () => {
  const states: string[] = [];
  const orch = createProfileRestartOrchestrator({
    pool: { remove: () => {} },
    supervisord: { restartProfile: async () => ({ ok: true, value: undefined }) },
    waitForWsReady: async () => ({ ok: true, value: undefined }),
    onState: (s) => states.push(s),
  });
  const r = await orch.restart("u_a", 30_000);
  expect(r.ok).toBe(true);
  expect(states).toEqual(["closing-ws", "restarting", "polling", "ready"]);
});

it("supervisord failure surfaces failed state", async () => {
  const orch = createProfileRestartOrchestrator({
    pool: { remove: () => {} },
    supervisord: { restartProfile: async () => ({ ok: false, error: { kind: "shell-failed", reason: "boom" } }) },
    waitForWsReady: async () => ({ ok: true, value: undefined }),
    onState: () => {},
  });
  const r = await orch.restart("u_a", 30_000);
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 2: Implement** (~100 lines)

- [ ] **Step 3: No commit yet.**

---

### Task D.4: Phase D commit

```bash
git add gateway/src/profile-store/personality-store.ts gateway/src/profile-store/personality-store.test.ts \
        gateway/src/admin/profile-edit-handlers.ts \
        gateway/src/admin/profile-restart-orchestrator.ts gateway/src/admin/profile-restart-orchestrator.test.ts \
        gateway/src/server/routes.ts
git commit -m "feat(gateway): self-service personality + SOUL endpoints with restart-spinner orchestration" -m "$(cat <<'EOF'
Endpoints (all self-service, auth = request matches authenticated user):
  GET/PUT  /api/profiles/<userId>/soul
  GET      /api/profiles/<userId>/personalities  (returns active_name)
  POST     /api/profiles/<userId>/personalities
  PUT      /api/profiles/<userId>/personalities/<name>
  DELETE   /api/profiles/<userId>/personalities/<name>
  POST     /api/profiles/<userId>/active-personality

Restart-orchestrator state machine: writing -> closing-ws -> restarting
-> polling -> ready (or failed). Active-personality posts /personality
slash command via the WS adapter as internal:true and never restarts.

personality-store resolves active_name by matching agent.system_prompt
against each entry's resolved body (Hermes _resolve_prompt algorithm).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase E — Webui self-service UX

The phase adds two tabs to Settings → My Agent: SOUL and Personality. Both consume the Phase D endpoints. Spinner overlay is shared.

### Task E.1: Spinner overlay component

**Files:**
- Create: `gateway/webui/src/components/restart-spinner.tsx`
- Create: `gateway/webui/src/components/restart-spinner.css`

Variants: `idle | saving | restarting | ready | failed`. Shows "Saving…" → "Restarting your assistant…" → "Ready" → fades out. On `failed`: red banner with retry + view-logs link.

- [ ] **Step 1: Implement** following BEM + design tokens already in the webui (read `gateway/webui/src/components/settings/my-agent/persona-section.tsx` for style precedent).

- [ ] **Step 2: No unit test** per test-lean (UI render). Browser smoke covers it in Phase G.

- [ ] **Step 3: No commit yet.**

---

### Task E.2: SOUL tab

**Files:**
- Create: `gateway/webui/src/components/settings/my-agent/soul-section.tsx`
- Modify: `gateway/webui/src/components/settings/my-agent/index.tsx` (add tab)

Layout: textarea (monospace, ~25 rows), Save button, Last-saved timestamp. On Save: POST `/api/profiles/<userId>/soul`, show `RestartSpinner`. On 200 → ready; on 4xx → inline error banner.

- [ ] **Step 1: Implement** the section component.
- [ ] **Step 2: Wire into the settings router/tab structure.**
- [ ] **Step 3: No commit yet.**

---

### Task E.3: Personality tab

**Files:**
- Create: `gateway/webui/src/components/settings/my-agent/personality-section.tsx`
- Modify: settings index to add tab

Layout per spec §8:
1. Active selector dropdown — calls `POST /active-personality`. No spinner; toast on success.
2. Edit form: dropdown (existing names) → loads body into textarea. Save → PUT (spinner). Delete → DELETE (spinner). + New → opens form blank, name required → POST (spinner).

- [ ] **Step 1: Implement** the section.
- [ ] **Step 2: Edge case: editing the active body re-fires `/personality <name>` after restart (gateway-side, not webui — webui does not need to know).**
- [ ] **Step 3: No commit yet.**

---

### Task E.4: Phase E commit

```bash
git add gateway/webui/src/components/restart-spinner.tsx \
        gateway/webui/src/components/restart-spinner.css \
        gateway/webui/src/components/settings/my-agent/
git commit -m "feat(webui): self-service SOUL + personality editing with restart-spinner UX" -m "$(cat <<'EOF'
Settings -> My Agent gains two tabs:
  SOUL         textarea + Save; spinner during the save->restart cycle.
  Personality  active dropdown (instant), edit form for existing entries,
               + New / Delete buttons (each triggers the spinner cycle).

Shared <RestartSpinner> component covers idle/saving/restarting/ready/
failed states with a clear retry path.

Edge: editing the body of the currently-active personality is handled
gateway-side (re-fires /personality after restart); webui shows one
spinner end-to-end with no extra ceremony.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase F — Compose migration

Single-shot compose change: remove per-user Hermes services, add the overlay container, shared supervisord socket.

### Task F.1: Update `deploy/docker/docker-compose.yml`

**Files:**
- Modify: `deploy/docker/docker-compose.yml`

Changes:
- Remove the 3 per-user Hermes services (`hermes-alice`, `hermes-bob`, `hermes-family`) and their compose-level secrets.
- Add a single `sentient-hermes` service:

```yaml
  sentient-hermes:
    container_name: sentient-hermes
    build:
      context: ../../deploy/hermes-overlay
    image: sentient/hermes:local
    restart: unless-stopped
    environment:
      - TZ=${TZ:-America/Vancouver}
    volumes:
      - ~/.sentient/gateway/data:/data/profiles
      - ~/.sentient/hermes-supervisor:/data/supervisor
      - /var/run/docker.sock:/var/run/docker.sock  # for terminal.backend: docker
    networks: [sentient-internal]
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "7"
```

- Remove `/var/run/docker.sock` mount on the `gateway` service.
- Add `~/.sentient/hermes-supervisor:/data/supervisor` shared mount on the `gateway` service so it can reach `supervisorctl`.
- Set `gateway` env: `SENTIENT_SUPERVISORD_SOCKET=/data/supervisor/supervisor.sock` for `supervisord-control` to read.

- [ ] **Step 1: Edit compose**.

- [ ] **Step 2: Drop secrets files**

```bash
git rm deploy/docker/secrets/hermes_api_key_alice deploy/docker/secrets/hermes_api_key_bob deploy/docker/secrets/hermes_api_key_family
```

- [ ] **Step 3: Build + boot full stack**

```bash
cd deploy/docker
docker compose build
docker compose up -d
docker compose ps
```

Expected: `sentient-hermes` up; existing `sentient-gateway` up.

- [ ] **Step 4: Boot-migration triggers — confirm one program per user appears**

```bash
docker exec sentient-hermes ls /data/supervisor/programs/
docker exec sentient-hermes supervisorctl status
```

Expected: one `<userId>.conf` per user; supervisorctl shows each `RUNNING`.

- [ ] **Step 5: Phase F commit**

```bash
git add deploy/docker/docker-compose.yml
git rm -r deploy/docker/secrets/hermes_api_key_*
git commit -m "feat(deploy): single sentient-hermes service replaces per-user containers" -m "$(cat <<'EOF'
docker-compose.yml drops hermes-alice / hermes-bob / hermes-family +
their compose secrets; adds one sentient-hermes service that builds
deploy/hermes-overlay/ and runs supervisord. Per-user processes are
spawned dynamically via supervisorctl from the gateway.

Mounts: ~/.sentient/gateway/data -> /data/profiles (per-user homes);
~/.sentient/hermes-supervisor -> /data/supervisor (shared with the
gateway container so supervisorctl reaches the daemon over its Unix
socket); /var/run/docker.sock -> /var/run/docker.sock (only for
Hermes' terminal.backend: docker per-tool sandbox).

The gateway service drops its own /var/run/docker.sock mount.

Boot-migration renders one supervisord program per existing user; the
overlay's supervisord picks them up via [include] glob.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase G — Live UX validation (Chrome DevTools MCP)

**This is the binding final task. UX/UI quality is part of "done."** The agent runs the full stack against the real webui, exercises every flow listed below as a real user would, and treats every console error / lingering spinner / confusing copy / visual jank as a finding to fix — not a "minor polish for later."

REQUIRED SUB-SKILL: `chrome-devtools-mcp:chrome-devtools` (available globally; the agent invokes via the `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*` tool family).

### Task G.1: Boot the live stack from a clean slate

- [ ] **Step 1: Stop anything running**

```bash
cd /Users/kevinye/Development/sentient/.worktrees/sentient-platform-adapter/deploy/docker
docker compose down
docker compose up -d --build
docker compose ps
```

Expected: `sentient-gateway`, `sentient-hermes`, `sentient-stt-service`, `sentient-egress-proxy`, `sentient-ha-mcp` all `running`.

- [ ] **Step 2: Tail logs in a separate terminal (or background a `docker compose logs -f` to a file)**

```bash
docker compose logs -f --tail=10 sentient-gateway sentient-hermes > /tmp/sentient-stack.log 2>&1 &
echo $! > /tmp/sentient-stack-tail.pid
```

Errors observed during validation should be cross-referenced with this log.

- [ ] **Step 3: Open the webui in a Chrome instance via the MCP**

Use `mcp__plugin_chrome-devtools-mcp_chrome-devtools__new_page` with URL `https://localhost:8888`. Accept the self-signed cert when prompted (the webui ships with a self-signed cert; first-time devices need a one-click acceptance).

---

### Task G.2: Login flow — be critical

- [ ] **Step 1: Take a fresh screenshot** of the login page (`take_screenshot`). Note immediately:
  - Is the page legible without scrolling?
  - Are the inputs labeled and focusable?
  - Are there any console errors (`list_console_messages`)?
  - Are there any failed network requests (`list_network_requests`)?

- [ ] **Step 2: Sign in as the admin user** with the credentials produced by setup. Use `fill` + `click`.

- [ ] **Step 3: After login, screenshot the landing screen.** File any UX findings:
  - Avatar/name visible?
  - Voice indicator present and idle?
  - Any layout shift visible after first frame paint?

- [ ] **Step 4: Findings → fixes**

For every finding above, decide: **fix now or document as separate ticket**. The bias is **fix now** — the user's instruction is "be very critical… find and fix things accordingly." Acceptable to defer only changes that go beyond the spec's scope (`gateway/src/cerebrum/`, voice pipeline, etc.) — for those, file a follow-up ticket.

After fixes: rebuild, redeploy, re-run the screenshots until the findings list for this step is empty.

---

### Task G.3: SOUL.md edit + restart spinner

- [ ] **Step 1: Navigate to Settings → My Agent → SOUL.**

- [ ] **Step 2: Critical questions**:
  - Is the textarea pre-populated with the current SOUL.md contents?
  - Is the cursor focusable?
  - Is "Save" disabled until content changes? (it should be)
  - Is the byte/char count visible?
  - Any console warnings?

- [ ] **Step 3: Edit one line.** Save. Watch the spinner.
  - Does the spinner appear within 100ms of clicking Save?
  - Does the assistant become unreachable during restart? (try voice activation; expect a clear "your assistant is restarting" state — not a silent failure)
  - Does the spinner clear within 10–15s?
  - Does the saved content survive a page refresh?

- [ ] **Step 4: Edge — fail the restart deliberately**

Stop the supervisord socket bind temporarily (`docker compose pause sentient-hermes`), edit SOUL again, click Save. Expected: failure state with clear copy + retry. Resume (`docker compose unpause sentient-hermes`), retry, succeed.

- [ ] **Step 5: Findings → fixes loop.**

---

### Task G.4: Personality CRUD + active selection

- [ ] **Step 1: Navigate to Settings → My Agent → Personality.**

- [ ] **Step 2: Validate dropdown population**: existing personalities show; "(none)" is selectable.

- [ ] **Step 3: Switch active personality** via dropdown. Expect:
  - Toast "Personality switched" within 1s.
  - No restart spinner (instant via `/personality` slash).
  - Voice prompt — actually talk to the assistant, hear it reply in the new persona.

- [ ] **Step 4: Add a new personality** ("test_focus", body "Be terse, no chitchat"). Expect:
  - Spinner ~5–10s.
  - After ready, the new entry appears in the dropdown.
  - Voice prompt verifies the persona is selectable + applies.

- [ ] **Step 5: Edit the active personality body** (the edge case from spec §8). Expect:
  - Spinner.
  - After ready, voice replies use the new body without manual reselect.

- [ ] **Step 6: Delete a non-active personality.** Spinner; entry gone from dropdown.

- [ ] **Step 7: Delete the currently-active personality.** Expect: gateway falls back to "(none)" gracefully; voice still works.

- [ ] **Step 8: Findings → fixes.**

---

### Task G.5: Tool-call rendering with a real conversation

- [ ] **Step 1: Voice-prompt the assistant** with something that triggers a real tool call. With the v1 tool roster, the easiest is `web_search`: "What's today's weather in Vancouver?"

- [ ] **Step 2: Watch the chat bubble**. Expect:
  - A tool-progress UI element appears: "🔍 web_search: q='weather Vancouver'…"
  - Within 1–3s, the tool element transitions to "✓ web_search (3 results)".
  - The assistant's spoken reply follows naturally.

- [ ] **Step 3: Network panel verification (`list_network_requests`)** — confirm the WS frames `tool.start` → `tool.end` were received in order with a single `assistant.message` after.

- [ ] **Step 4: Try one that triggers HA tools** ("turn on the kitchen light"). Same expectations.

- [ ] **Step 5: Findings → fixes.**

---

### Task G.6: Barge-in test

- [ ] **Step 1: Voice-prompt** with something that yields a long reply ("explain how the moon affects tides").

- [ ] **Step 2: Mid-reply, start speaking.** Expect:
  - TTS stops within 200ms.
  - The new utterance is captured and dispatched.
  - The previous turn's tail (un-spoken text) is discarded but logged.

- [ ] **Step 3: Repeat 3 times in quick succession.** Race condition coverage: stop, start, stop, start. Expect: no crash, no hang.

- [ ] **Step 4: Repeat under tool-call** (interrupt during a `web_search` cycle). Expect: tool cancels (the `user.cancel` frame fires), assistant stops cleanly, new turn proceeds.

- [ ] **Step 5: Findings → fixes.**

---

### Task G.7: Findings consolidation + fix loop

- [ ] **Step 1: Compile findings into a temporary doc** at `docs/superpowers/plans/notes/2026-04-26-platform-adapter-uxv-findings.md`. Each finding: severity (blocker / polish / future), file paths, repro steps, screenshots if relevant.

- [ ] **Step 2: Apply blocker + polish fixes inline.** For each fix, commit individually:

```bash
git commit -m "fix(<area>): <specific finding>" -m "Surfaced during Phase G UX validation."
```

- [ ] **Step 3: After every fix, re-run G.2–G.6.** Iterate until the blocker list is empty and the polish list is intentionally deferred (with tickets).

- [ ] **Step 4: Final sanity sweep**:
  - All console errors resolved or documented.
  - All failed network requests resolved or expected (e.g., `/v1/responses` 404s are expected — gateway no longer uses it; if any are visible, we're still calling the old path somewhere).
  - All Lighthouse audits at "good" or above for the settings pages (`lighthouse_audit`).

- [ ] **Step 5: Stop the log tail**

```bash
kill "$(cat /tmp/sentient-stack-tail.pid)"
rm /tmp/sentient-stack-tail.pid
```

- [ ] **Step 6: Phase G commit** (the findings doc + any fix commits already made earlier; final commit closes the doc out)

```bash
git add docs/superpowers/plans/notes/2026-04-26-platform-adapter-uxv-findings.md
git commit -m "docs(plans): Phase G UX validation findings + outcomes" -m "$(cat <<'EOF'
Captures the findings list compiled while driving the live stack via
Chrome DevTools MCP, the per-finding severity (blocker / polish /
future), the fixes applied inline (each its own commit), and the
deferred items with linked tickets.

Closes the plan's Phase G validation gate. The blocker list is empty;
polish items either fixed in-line or filed as follow-ups.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase H — Phase 7.5 retirement

**Why:** Now that the new path is proven on a live stack (Phase G), retire the obsolete docker-pool reconciler and friends. Doing this AFTER validation is deliberate — it preserves a fallback path if Phase G surfaces a blocker we can't fix in-session.

### Task H.1: Delete reconciler + container-spec + docker-control extensions

**Files (delete):**
- `gateway/src/admin/hermes-pool-reconciler.ts` + test
- `gateway/src/admin/hermes-container-spec.ts` + test
- `gateway/src/admin/profile-dir-migration.ts` + test (Phase 7.5–specific migration; the new world doesn't need it)
- `gateway/src/admin/internal-secrets-store.ts`'s `hermesAuthToken` field schema is repurposed (Task H.2) — the file itself stays.

**Files (trim):**
- `gateway/src/infrastructure/docker-control.ts`: keep only `restart` if used elsewhere; otherwise delete the whole file. Run `grep -rln "docker-control" gateway/src --include="*.ts" | grep -v test` before deletion.

- [ ] **Step 1: Confirm no live consumers**

```bash
grep -rln "hermes-pool-reconciler\|hermes-container-spec\|profile-dir-migration" gateway/src --include="*.ts" | grep -v test
```

Expected: empty (after Phase C wiring). If anything appears, fix the consumer first.

- [ ] **Step 2: Delete files**

```bash
git rm gateway/src/admin/hermes-pool-reconciler.ts gateway/src/admin/hermes-pool-reconciler.test.ts
git rm gateway/src/admin/hermes-container-spec.ts gateway/src/admin/hermes-container-spec.test.ts
git rm gateway/src/admin/profile-dir-migration.ts gateway/src/admin/profile-dir-migration.test.ts
```

- [ ] **Step 3: Run full test suite**

```bash
docker compose stop  # ports
cd gateway && bun run test 2>&1 | tail -5
cd .. && docker compose up -d
```

Expected: zero failures (anything that referenced the deleted modules has been re-wired in earlier phases).

- [ ] **Step 4: Trim docker-control.ts**

If `grep -rln "dockerControl\.create\|dockerControl\.start\|dockerControl\.stop\|dockerControl\.remove\|dockerControl\.inspect" gateway/src --include="*.ts" | grep -v test` is empty, delete those methods + their tests. Keep `restart` only if any non-Hermes consumer uses it. If nothing uses anything → delete the whole file.

- [ ] **Step 5: Repurpose internal-secrets-store**

Rename `hermesAuthToken` → `sentientGatewayToken` in the JSON schema + reader API. One-time migration on read: if `hermesAuthToken` is present and `sentientGatewayToken` is not, rename + write back. Update all consumers.

- [ ] **Step 6: No commit yet (one final Phase H commit covers all retirement).**

---

### Task H.2: Drop `Dockerfile.slim` and the old hermes/ subdir

```bash
git rm -r deploy/docker/hermes/
```

---

### Task H.3: Phase H commit

```bash
git add -A gateway/src/admin/internal-secrets-store.ts gateway/src/infrastructure/docker-control.ts \
          deploy/docker/hermes/ \
          gateway/src/admin/hermes-pool-reconciler.ts gateway/src/admin/hermes-container-spec.ts gateway/src/admin/profile-dir-migration.ts
git commit -m "chore(gateway): retire Phase 7.5 docker-pool components" -m "$(cat <<'EOF'
The platform-adapter pivot has shipped end-to-end (Phases A–G) and passed
live UX validation. Retiring the docker-engine-driven pool:

Deleted:
  gateway/src/admin/hermes-pool-reconciler.{ts,test.ts}
  gateway/src/admin/hermes-container-spec.{ts,test.ts}
  gateway/src/admin/profile-dir-migration.{ts,test.ts}
  deploy/docker/hermes/Dockerfile.slim and the surrounding subdir

Trimmed:
  gateway/src/infrastructure/docker-control.ts (kept restart only if
  still used by a non-Hermes consumer; otherwise file is gone)

Repurposed:
  gateway/src/admin/internal-secrets-store.ts now stores
  sentientGatewayToken (one-time migration from hermesAuthToken).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (run before declaring this plan complete)

1. **Spec coverage:**
   - §3 architecture: covered by Phases A+C+F
   - §4 overlay & topology: A, F
   - §5 adapter contract: A.2, A.3-A.7
   - §6 patches: A.3-A.7 (5 patches)
   - §7 WS protocol: B.1-B.2 (zod schema + FSM); A.9 (live)
   - §8 personality + SOUL endpoints: D.1-D.4; webui in E
   - §9 retirement / kept / new: C, H, F
   - §10 migration: F
   - §11 maintenance: README in overlay, plus rebase workflow in A.8 step
   - §12 verification: G (Chrome DevTools MCP, the binding final phase)
   - §13 risks: addressed inline (C.5 socket POC, A.8 patch-fail-fast, etc.)
   - §14 deferred: each phase explicitly opts out of cron / per-token streaming / etc.
   - §15 open questions: all four answered in the plan's "decisions made for the plan" notes embedded in tasks B.1, B.5, C.5, G plan.

2. **Placeholder scan:** Search for `TBD`, `TODO`, `<<EOF...EOF>>` placeholders that weren't filled in. Replace any remaining with concrete content.

3. **Type consistency:** `HermesClient`, `HermesEvent`, `MessageEvent`, `SendResult`, `ConnectionEvents`, `AnyFrame`, `OutboundFrame` — used consistently across tasks.

4. **Hard-rule consistency:** Each task that runs tests respects the `docker compose stop` requirement (memory `feedback_docker_ps_before_tests.md`); commits use the project's `Co-Authored-By` trailer.
