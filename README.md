# Sentient

A real-time streaming voice assistant for the home. Built around streaming
STT, streaming TTS, mid-response barge-in, and a **per-user agent runtime
sandboxed inside a Sentient-managed container jail** so a compromised
agent cannot reach the host or other family members. Runs on a pair of
Raspberry Pi 5 boards in production (or a single dev box for local
development), with a web client today and an ESP32-S3 hardware "cube" +
mobile clients in progress.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Host (Pi 5 / Mac)                                                      │
│                                                                         │
│  ┌──────────────────────────────────────────────────┐                   │
│  │  sentient-external (bridge — has host route)     │                   │
│  │                                                  │                   │
│  │  ┌───────────────────────────────┐   :8888 ◄── clients (web / cube) │
│  │  │  sentient-gateway (Bun/TS)    │                                   │
│  │  │  ─ terminates WS              │                                   │
│  │  │  ─ STT pipeline               │                                   │
│  │  │  ─ TTS pipeline               │                                   │
│  │  │  ─ system-orchestrator ───────┼──► /var/run/docker.sock           │
│  │  │     (dockerode, group_add     │     (no host-root, no privileged) │
│  │  │      HOST_DOCKER_GID only)    │                                   │
│  │  └───────────────┬───────────────┘                                   │
│  └──────────────────┼──────────────────────────────────────────────────┘│
│                     │ spawns / supervises sibling containers            │
│                     ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  sentient-internal (bridge — `internal: true`, NO host route,      │ │
│  │                     NO published ports)                            │ │
│  │                                                                    │ │
│  │  ┌──────────────────────────────────────┐    ┌──────────────────┐  │ │
│  │  │  sentient-hermes (containment wrap)  │    │  stt-service     │  │ │
│  │  │  ┌────────────────────────────────┐  │    │  (VAD + ASR)     │  │ │
│  │  │  │  supervisord (PID 1)           │  │    └──────────────────┘  │ │
│  │  │  │  ├─ hermes -p alice (acp)      │  │    ┌──────┐ ┌──────────┐ │ │
│  │  │  │  ├─ hermes -p alice (dash)     │  │    │ ha-  │ │ ma-mcp   │ │ │
│  │  │  │  ├─ hermes -p bob   (acp)      │  │    │ mcp  │ └──────────┘ │ │
│  │  │  │  ├─ hermes -p bob   (dash)     │  │    └──────┘ ┌──────────┐ │ │
│  │  │  │  └─ ...                        │  │    ┌──────┐ │ fetch-mcp│ │ │
│  │  │  └────────────────────────────────┘  │    │searx │ └──────────┘ │ │
│  │  │              │ docker.sock           │    │ng-mcp│              │ │
│  │  │              │ (per-task sandbox)    │    └──────┘              │ │
│  │  │              ▼                       │                          │ │
│  │  │  ┌────────────────────────────────┐  │                          │ │
│  │  │  │  ephemeral sandbox containers  │  │                          │ │
│  │  │  │  (one per tool call —          │  │                          │ │
│  │  │  │   workspace bind = HERMES_HOME │  │                          │ │
│  │  │  │   /profiles/<userId>/...)      │  │                          │ │
│  │  │  └────────────────────────────────┘  │                          │ │
│  │  └────────────┬─────────────────────────┘                          │ │
│  │               │ HTTP(S)_PROXY                                      │ │
│  │               ▼                                                    │ │
│  │  ┌─────────────────────────┐                                       │ │
│  │  │  egress-proxy           │──► internet (tinyproxy denylist)      │ │
│  │  │  (tinyproxy)            │                                       │ │
│  │  └─────────────────────────┘                                       │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
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
- **Per-user agent loop** — each family member has their own
  [Hermes](#hermes) worker that owns the LLM call, agent loop, tool
  dispatch, and conversation memory.
- **Browser-side echo cancellation** — TTS audio routes through a local
  `RTCPeerConnection` loopback so the browser's built-in AEC subtracts the
  assistant's voice from mic input — no false barge-in from self-audio.
- **First-boot wizard** — provider keys, admin token, and the first user
  account are entered through a guided web wizard, not pre-provisioned
  config files. Open `https://localhost:8888` after the stack boots and
  follow the prompts.
- **Open and runnable** — docker compose, one `HOST_DOCKER_GID` env var,
  the stack boots on a Mac in a few minutes.

## What makes Sentient specific

Three design choices that don't exist in hosted real-time voice APIs or
in stock Hermes:

### 1. Gateway is the system orchestrator

`sentient-gateway` is not just a WebSocket terminator — it owns the
lifecycle of every sibling container in the stack (Hermes, STT, all MCPs,
egress proxy, signal-cli). The orchestrator at
`gateway/src/system-orchestrator/` drives dockerode over the bind-mounted
`/var/run/docker.sock`. Each managed service is a YAML template under
`gateway/templates/services/*.yaml` with `${HOST_*}` env and `${SECRET}`
substitution. On boot, a reconciler converges the declared registry
against actual docker state; on every wizard or settings edit, the
registry is rebuilt and `applyAll`/`applySubset` re-converges without a
gateway restart.

Access to the docker socket is granted via `group_add: HOST_DOCKER_GID`
— no host-root inside the container, no `--privileged`.

### 2. Hermes runs inside a Sentient-managed containment wrapper

Upstream Hermes is designed to run as a trusted host process. Its
docker-backend (used for per-task tool sandboxes) asks the daemon to
bind-mount the worker's `HERMES_HOME` into each fresh sandbox container.
On a single-user dev box that's fine; in a family setup with a chat
agent reachable by voice, the trust model is wrong — a worker filesystem
write goes straight to `$HOME` on the host.

Sentient wraps the whole Hermes runtime in a `sentient-hermes`
container. The wrap:

- **Jails worker writes.** Anything Hermes writes outside the explicit
  mount subtree (`~/.sentient/gateway/data`) dies with the container.
- **Funnels every per-task sandbox through one audited root.** Hermes'
  docker-backend can only bind-mount paths under
  `<HERMES_HOME>/profiles/<userId>/` — the wrapper enforces that
  HERMES_HOME for every user is a child of the gateway's data dir.
- **Forces all outbound traffic** through `egress-proxy` via
  `HTTP_PROXY` / `HTTPS_PROXY`. No direct internet access from worker
  code.
- **Applies resource limits** (memory + CPU) at the container layer, not
  the honor system.
- **Hands lifecycle control** to the gateway via `supervisorctl` over a
  unix socket the gateway mounts in. Adding or removing a family member
  is a `supervisorctl reread && update` — no manual container surgery.

Per-user agent loops are supervisord-managed processes inside this wrap
(one ACP program + one dashboard sidecar per user). Per-task tool runs
spawn ephemeral sandbox containers via Hermes' own docker-backend, all
rooted at the wrapper's HERMES_HOME.

### 3. Network isolation + egress denylist by default

The stack runs on two docker bridges:

- `sentient-external` — only `sentient-gateway` attaches. Has the host
  route. The single externally reachable surface.
- `sentient-internal` — `internal: true`. No host gateway, no published
  ports. Every other container (Hermes wrap, STT, MCPs, egress-proxy)
  lives only here.

Outbound Hermes traffic is forced through the `egress-proxy` (tinyproxy)
container, which applies a hostname denylist. A compromised agent cannot
exfiltrate to arbitrary internet hosts without going through the proxy's
filter.

Defense-in-depth additions on top of the network posture, in
`gateway/src/security/`:

- **Prompt-injection scanner** — six pattern categories
  (`ignore_instructions`, `override_system`, `leak_prompt`,
  `disobey_role`, `jailbreak_phrases`, `inline_tool_invocation`). Pure
  observability — feeds the risk accumulator, never blocks output
  silently.
- **Policy engine** — declarative tool-call gating. Rules read
  `tool` / `userId` / `role` / `session.channel` / `args.*` predicates
  and emit `allow` / `deny` / `confirm`. No dynamic eval; predicates are
  parsed into a fixed AST.
- **Risk accumulator** — exponential-decay running score with
  `none` / `warn` / `escalate` / `block` levels driven by configurable
  per-event weights.
- **Log sanitizer** — every log entry passes through a redactor that
  strips PASETO tokens, Bearer tokens, and `sak_` keys before write.
- **Auth surfaces** — PIN → PASETO v4.local session token for browsers
  (`gateway/src/user-auth/`); a wizard-issued admin token gates
  `/api/v1/admin/*`; service-to-service auth is "you must be on
  `sentient-internal`."

### Honest gaps

The threat model isn't airtight and we don't pretend otherwise. Tracked
in `gateway/todo.md`:

- The docker socket mounted into `sentient-hermes` is host-root-equivalent
  if a worker is compromised. Mitigation: rootless docker / sysbox runtime,
  on the roadmap.
- Per-user workers share one `sentient-hermes` container — user-to-user
  isolation is process-level (uid 10000 + supervisord), not container-level.
  Splitting workers into per-user containers is on the roadmap.
- `sentient-internal` allows raw-TCP between containers; a compromised
  worker can reach sibling MCPs without going through the egress proxy.
  Mitigation: dedicated `sentient-task` network for sandboxes, iptables
  egress allowlist.
- The per-task sandbox image is upstream
  (`nikolaik/python-nodejs:python3.11-nodejs20`), not Sentient-audited.
  Mitigation: ship a pinned `ghcr.io/sentient/agent-sandbox:<tag>`.

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

External stimuli that arrive during an active cycle (i.e. a sensor event)
accumulate in gateway. The `AttentionGate` fires the next cycle at the
natural end of the current one.

Session-level cancellation is split into two controllers:
- `bargeInController` — mic-onset → abort cycle + TTS, keep tool tasks alive
- `interruptController` — UI Stop button → abort cycle + TTS, plus task-cancel
  to Hermes for any interruptible tools

The full deep-dive lives in `ARCHITECTURE.md`.

## Latency
TBD
<!-- Measured end-to-end latency numbers will land here after the measurement
protocol runs. Until then, the rough working budget is:

| Metric | Target |
|---|---|
| End-to-end (mic close → first TTS audio) | sub-second |
| Barge-in (mic onset → TTS stops) | sub-200 ms |
| TTS first-byte | sub-150 ms | -->

## Demo

TBD

## How this was built

This repository is human-authored with Claude Code as a pair-programming
partner. Commits where the agent materially shaped the code carry a
`Co-Authored-By: Claude` trailer.

Architecture decisions, public API shapes, and test scaffolding are
human-written. The agent accelerates research, generates boilerplate,
executes typed-mechanical refactors, and drafts test cases. Every commit
is reviewed before merge.

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

Sentient runs Hermes inside a Sentient-built containment wrapper
(`deploy/hermes-overlay/`) — see [What makes Sentient
specific](#what-makes-sentient-specific) for the rationale.
