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
- **TTS**: streams text per cycle to Fish Audio via msgpack WebSocket;
  serializes overlapping cycles' audio with a small fade for clean
  preempts.
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
                       utterance-aggregator ─► content-tts ─► Fish Audio
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
3. Client sends `session.configure`; gateway replies `session.ready`.
4. Audio + text flow until the client disconnects or idles.
5. PersonSession persists for `session_persist_ms` (default 2 minutes,
   configurable in `config.yaml`) after disconnect; reopen within that
   window rejoins the same conversation.

## TTS

Live WebSocket streaming to `wss://api.fish.audio/v1/tts/live` using
the msgpack binary protocol. One TTS run per cycle: opens, streams
the per-cycle text, finishes when the cycle's `\n` boundary is hit,
closes. New cycle = new connection.

## Configuration

Tunables live in [`config.yaml`](config.yaml). Key sections:

| Section | Covers |
|---------|--------|
| `server` | port, host, TLS hostnames |
| `session.barge_in` | barge-in policy |
| `stt` | STTService URL, language, energy gate, sample rates |
| `tts` | Fish Audio voice, format, chunk size, timeouts |
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
- TTS: Fish Audio
- Validation: zod

## Commands

```
bun run dev       — Start gateway with hot reload
bun run test      — Run all gateway tests
bun run build     — Production build
bun run typecheck — TypeScript strict check
```
