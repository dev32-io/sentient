# Gateway

Bun/TypeScript voice gateway. The Hermes platform adapter — terminates
the client WebSocket, runs STT/TTS, hosts gateway-side MCP tools, and
translates Hermes events back into the SDK's wire protocol.

## What the gateway does

The gateway does NOT run the LLM. Hermes (a separate runtime supervised
by `supervisord` inside the `sentient-hermes` container, one worker
per user) owns the LLM call, agent loop, tool execution, and per-user
profile memory. The gateway dials each user's Hermes worker over
WebSocket via `hermes-adapter-client/`, sends `user.message`, and
handles the streamed `assistant.message` / `tool.started` / `cycle.done`
frames coming back.

What the gateway IS responsible for:

- WebSocket termination for browser/mobile clients (binary audio + JSON control).
- **STT**: dials the local STTService (Python service in
  `capabilityServices/STTService/`) over WS; downsamples 48 kHz client
  audio to 16 kHz, gates on energy, and streams PCM. STTService wraps
  Silero VAD → Smart-Turn v3 → SenseVoice-Small and emits structured
  turn events back. The gateway is its client and never knows about
  the VAD / turn / STT internals.
- **TTS**: streams text per cycle to the local-tts (LocalTTSService)
  provider via a JSON+binary WebSocket; serializes overlapping cycles'
  audio with a small fade for clean preempts.
- **MCP host**: per-user unix sockets exposing gateway-side tools
  (`identify_user`, `pause_audio`, `resume_audio`, `update_user_settings`).
  Hermes calls them via standard MCP transport.
- **AttentionGate**: decides WHEN a cycle should fire based on conversation
  + ambient salience, then dispatches via `hermes-adapter-client`.
- **Cerebrum mirrors**: `ConversationMirror` and `TaskMirror` are read-only
  views of Hermes-owned state, used to translate events into the SDK
  protocol the webui already speaks.
- **Profile store**: renders each user's Hermes config + SOUL.md into
  `<gatewayRoot>/<userId>/`, drives `supervisorctl reread && update`
  to spawn/restart the user's worker.
- **Auth**: PASETO v4.local browser session tokens issued by `user-auth/`.
  Internal services (gateway ↔ STT, gateway ↔ Hermes worker) live on the
  `sentient-internal` docker network and are not separately authenticated;
  the gateway is the only externally-reachable service.

## Pipeline

```
Mic audio ─► STT adapter ─► (text)             ▲
                                │              │
                                ▼              │
                         AttentionGate         │
                         (cycle decision)      │
                                │              │
                                ▼              │ assistant.message
                         hermes-adapter-client ┘ (per cycle, suffixed \n
                                │                for utterance flush)
                                ▼
                                content-tts ─► local-tts
                                                   │
                                                   ▼
                                            audio frames ─► client
```

A trailing `\n` on each `assistant.message` is the per-cycle TTS flush
boundary — without it, intermediate narration sits buffered until the
final answer and the run feels sluggish.

## Barge-in

`bargeInController` aborts the in-flight cycle and TTS when the
client signals mic onset during playback. Tasks running in Hermes are
NOT cancelled by barge-in — that's reserved for the explicit Stop
gesture, which goes through `interruptController` and routes a
task-cancel request to Hermes alongside the cycle/TTS abort.

## Session lifecycle

1. Client connects on `wss://<host>:8888/ws` with a PASETO bearer.
2. `ws-auth-gate` validates the token, looks up the user, attaches the
   user's Hermes worker connection (already pre-warmed by the
   per-profile-connection FSM).
3. Client sends `session.configure` (REQUIRES a stable `deviceId`; an optional
   `resume:{epoch,lastSeq}` on a reconnect); gateway replies `session.ready`
   (and `stream.resumed` if a resume was requested).
4. Audio + text flow until the client disconnects or idles.
5. On disconnect the in-flight cycle keeps running and its frames are journaled
   into the per-device replay buffer; the PersonSession + buffer survive
   `session.retention_ttl_ms` (default 30 min), then evict. Reconnect within that
   window resumes cheaply (replay frames `> lastSeq`); beyond it the client
   REST-refetches history. Two timers, by design: the Bun socket idle-closes at
   `session.ws_idle_timeout_ms` (≤255s, Bun's cap), but the app-level session
   outlives the socket for the full 30-min TTL.

## Transport boundary (WS vs REST)

The WebSocket carries the **live chat session only** — mic audio, TTS audio, the
live conversation stream (`conversation.entry`, `cycle.*`, `cognition.status`,
`task.update`), `ping`/`pong`, `interrupt`, and the resume handshake. Everything
on the WS push channel is `seq`-stamped and replay-buffered. **Everything
client-driven is REST**: session list, conversation history, search, rename,
delete, preferences — under `/api/v1/sessions`. The old WS query RPCs
(`session.switch` → `conversation.snapshot`, list, preferences) were removed; a
lightweight WS `conversation.activate` focuses the live stream (no history
payload). Full wire contract: [`../shared/protocol/WIRE.md`](../shared/protocol/WIRE.md).

## TTS

Live WebSocket streaming to the native local-tts (LocalTTSService)
provider running on the host (Metal/MLX), reached via
`ws://host.docker.internal:8770`. JSON text frames for control, raw
binary frames for audio — see `local-tts-protocol.ts` and
`capabilityServices/LocalTTSService/CONTRACT.md`. One TTS run per
cycle: opens, streams the per-cycle text, finishes when the cycle's
`\n` boundary is hit, closes. New cycle = new connection.

## Configuration

Tunables live in [`config.yaml`](config.yaml). Key sections:

| Section | Covers |
|---------|--------|
| `server` | port, host, TLS hostnames |
| `session.barge_in` | barge-in policy |
| `stt` | STTService URL, language, energy gate, sample rates |
| `tts` | local-tts URL, voice, format, sample rate, connect timeout |
| `webui` | server-authoritative client tunables (e.g. playback) |
| `providers` | catalog cache TTLs, external fetch timeout |
| `mcp_catalog` | operator-managed MCP server inventory + per-server `tools.include` curation |
| `hermes` | sentient-hermes URL, per-user profile slot config |

Per-user behavior (chat model, voice ID, persona, MCP toggles) lives in
the rendered profile at `<gatewayRoot>/<userId>/config.yaml`, not in
this file.

## Stack

- Runtime: Bun
- Language: TypeScript (strict mode)
- Test runner: `bun test` for unit; Vitest for integration (`test:int`)
- WebSocket: Bun built-in
- LLM: Hermes worker (per user, dialed over WebSocket)
- STT: local STTService (Python: Silero VAD + Smart-Turn v3 + SenseVoice-Small)
- TTS: local-tts (LocalTTSService, native Metal/MLX)
- Validation: zod

## Commands

```
bun run dev       — Start gateway with hot reload
bun run test      — Run all gateway tests
bun run build     — Production build
bun run typecheck — TypeScript strict check
```
