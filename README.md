# Sentient

A real-time streaming voice assistant for the home. Built around streaming
STT, streaming TTS, mid-response barge-in, and a per-user agent loop
backed by [Hermes](#hermes). Runs on a pair of Raspberry Pi 5 boards in
production (or a single dev box for local development), with a web client
today and an ESP32-S3 hardware "cube" + mobile clients in progress.

```
Client (web / cube / future mobile)
    │  WebSocket  (binary audio + JSON control)
    ▼
Sentient Gateway   ───►  STTService  (Silero VAD + Smart-Turn v3 + SenseVoice-Small)
(Bun / TypeScript)
    │
    ├─►  Fish Audio TTS  (streaming)
    │
    └─►  hermes-adapter-client
              │  ACP / JSON-RPC 2.0 over WebSocket
              ▼
         sentient-hermes container
         (one supervisord-managed `hermes -p <user>` worker per user)
```

**Status:** gateway runs in production at one household. ESP32 cube
firmware is in active development (Phase 5.5). Android and iOS clients
are planned but not yet started — see `ROADMAP.md`.

## What it does

- **Streaming voice** end-to-end: voice activity detection, partial STT,
  streaming LLM tokens, streaming TTS, all overlapped.
- **Barge-in** mid-response: when the user starts speaking while the
  assistant is talking, the assistant cancels playback and the in-flight
  cycle within a sub-second budget.
- **Per-user agent loop:** each family member has their own Hermes worker
  that owns the LLM call, agent loop, tool dispatch, and conversation
  memory.
- **Browser-side echo cancellation:** TTS audio routes through a local
  `RTCPeerConnection` loopback so the browser's built-in AEC subtracts the
  assistant's voice from mic input — no false barge-in from self-audio.
- **First-boot wizard:** provider keys, admin token, and the first user
  account are entered through a guided web wizard, not pre-provisioned
  config files. Open `https://localhost:8888` after the stack boots and
  follow the prompts.
- **Open and runnable:** docker compose, one `HOST_DOCKER_GID` env var,
  the stack boots on a Mac in a few minutes.

## Hardware

- **Production install:** dual Raspberry Pi 5 (capture Pi for mic + STT;
  compute Pi for Hermes + TTS). Splitting capture from compute keeps mic
  latency deterministic when the LLM container is busy.
- **Local development:** any Linux or macOS box with Docker.

## Quick start (local dev)

```bash
# 1. Configure the host-side Docker GID (the gateway needs to shell out
#    to `docker run` for per-user Hermes workers)
cp deploy/docker/.env.example deploy/docker/.env
# Edit deploy/docker/.env and fill in HOST_DOCKER_GID per the comments
# in that file.

# 2. Build + start the stack
docker compose -f deploy/docker/docker-compose.yml build
docker compose -f deploy/docker/docker-compose.yml up -d

# 3. Open https://localhost:8888/ (accept the self-signed cert once
#    per browser). The setup wizard will collect:
#      - OPENROUTER_API_KEY        (https://openrouter.ai/keys)
#      - FISH_AUDIO_API_KEY        (https://fish.audio/developers)
#      - admin token (auto-generated, copy it somewhere safe)
#      - the first user account (a PIN you'll use to sign in)
#    All collected secrets land in ~/.sentient/secrets/keys.yaml,
#    managed by the gateway and never committed to the repo.
```

See `ARCHITECTURE.md` for the full architectural deep-dive, and
`docs/diagrams/architecture.md` for the pipeline mermaid source.

## Architecture overview

A *cognitive cycle* is one Hermes round-trip identified by `cycleId`. The
gateway sends a `user.message`. Hermes streams one or more
`assistant.message` frames (intermediate narration → tool calls → final
answer), then terminates with `cycle.done`. The gateway dispatches cycles
through `AttentionGate` — the only path that can fire a cycle — and
translates inbound Hermes events back into the SDK wire protocol so the
web client never needs to know Hermes exists. The gateway↔Hermes link is
ACP (Agent Client Protocol) — JSON-RPC 2.0 over WebSocket; per-user
profiles each get their own ACP session via `gateway/src/hermes-adapter-client/`.

External stimuli that arrive during an active cycle (a second user
message, a sensor event) accumulate in `ShortTermContext`. The gate fires
the next cycle at the natural end of the current one, with everything
since `lastCycleEndSeq`. ReAct continuations run back-to-back, bounded by
`maxIterations`.

Session-level cancellation is split into two controllers:
- `bargeInController` — mic-onset → abort cycle + TTS, keep tool tasks alive
- `interruptController` — UI Stop button → abort cycle + TTS, plus task-cancel
  to Hermes for any interruptible tools

The full deep-dive lives in `ARCHITECTURE.md`.

## Latency

Measured end-to-end latency numbers will land here after the measurement
protocol runs. Until then, the rough working budget is:

| Metric | Target |
|---|---|
| End-to-end (mic close → first TTS audio) | sub-second |
| Barge-in (mic onset → TTS stops) | sub-200 ms |
| TTS first-byte | sub-150 ms |

## Demo

A 30–60 second screen capture of a conversation including a barge-in
will land here once recorded.

## How this was built

This repository is human-authored with Claude Code as a pair-programming
partner. Commits where the agent materially shaped the code carry a
`Co-Authored-By: Claude` trailer.

Architecture decisions, public API shapes, and test scaffolding are
human-written. The agent accelerates research, generates boilerplate,
executes typed-mechanical refactors, and drafts test cases. Every commit
is reviewed before merge.

Audit trail:

```bash
git log --grep "Co-Authored-By: Claude"
```

## License

[MIT](./LICENSE). Third-party attributions in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and (for the firmware
tree) [`esp32/cube/firmware/THIRD_PARTY_NOTICES.md`](./esp32/cube/firmware/THIRD_PARTY_NOTICES.md).

Note: the SenseVoice-Small ONNX model weights, downloaded at Docker build
time by the STT service, ship under the upstream **FunASR Model Open
Source License v1.1** (Alibaba), separate from this project's MIT license.
Details in `THIRD_PARTY_NOTICES.md`.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Hermes

Hermes is the agent runtime that owns the LLM call, agent loop, tool
dispatch, and per-user profile memory. It's a separate runtime from this
gateway. The gateway dials Hermes over ACP (Agent Client Protocol —
JSON-RPC 2.0 over WebSocket) via `gateway/src/hermes-adapter-client/`,
opening one ACP session per user profile.
