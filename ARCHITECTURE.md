# Architecture

## System overview

Sentient is composed of three runtimes:

1. **Gateway** (this repository, Bun + TypeScript) — terminates client
   WebSocket connections, runs STT and TTS, hosts a small MCP server for
   gateway-side tools (`identify_user`, `pause_audio`, `resume_audio`,
   `update_user_settings`), and dials Hermes for the agent loop.
2. **STT Service** (this repository, Python) — Silero VAD +
   Smart-Turn v3 turn detector + SenseVoice-Small ASR, all wrapped in a
   small WebSocket server. Local, on-device, no cloud STT call.
3. **Hermes** — a separate runtime (not in this repo) that owns the LLM
   call, agent loop, tool dispatch, and per-user profile memory. One
   `hermes -p <user>` worker per user, managed by supervisord inside a
   single `sentient-hermes` container.

Clients today: a Preact web app with a voice+text composer (voice mode
toggleable via the mic button). In progress: an ESP32-S3 hardware cube
client. Planned: native Android and iOS clients.

## Cognitive cycle

A *cognitive cycle* is one Hermes round-trip identified by `cycleId`. The
gateway sends a `user.message`. Hermes streams one or more
`assistant.message` frames (intermediate narration → tool calls → final
answer), then terminates with `cycle.done`. Cycles are atomic: at most
one active per session.

`AttentionGate` (`gateway/src/cerebrum/attention-gate.ts`) is the only
path that can dispatch a cycle. External stimuli that arrive during an
active cycle accumulate in `ShortTermContext`. The gate fires the next
cycle at the natural end of the current one with everything since
`lastCycleEndSeq`. ReAct continuations run back-to-back, bounded by
`maxIterations`.

## Gateway ↔ Hermes protocol

The gateway dials Hermes over **ACP (Agent Client Protocol)** — JSON-RPC
2.0 over WebSocket (path `/acp`). The client lives at
`gateway/src/hermes-adapter-client/` (`acp-hermes-client.ts`,
`per-profile-connection.ts`, `client.ts`, `event-translator.ts`,
`schemas.ts`). Each user profile gets its own ACP session, opened on
demand and pooled per-profile.

ACP defines the request/notification surface (`session/prompt`,
`session/update`, `session/cancel`, etc.); the event translator maps
inbound `session/update` notifications back to the SDK's wire protocol
so the browser/cube/mobile clients never see ACP directly.

## Salience accumulation

The attention gate owns two salience accumulators: `conversationSalience`
(bumped by user/trigger entries) and `ambientSalience` (bumped by sensor
events and other ambient stimuli). Each wake signal looks up a
source-neutral salience key (`conversation.user.text`,
`conversation.trigger`, `sensor.*`) and increments the appropriate
accumulator. At dispatch time the two are merged and compared against a
threshold.

User interrupt clears the conversation accumulator only. Ambient salience
remains so the next cycle can still dispatch on ambient backlog.

## Cancellation

Session-level cancellation is split into two controllers:

- **`bargeInController`** — mic-onset triggers this. Aborts the in-flight
  cycle and TTS but keeps tool tasks alive. The user is interrupting the
  *response*, not necessarily the *work*.
- **`interruptController`** — UI Stop button triggers this. Aborts the
  cycle and TTS, and additionally requests task cancellation from Hermes
  for any interruptible tools.

Cutoff kinds on committed assistant entries: `interrupt | barge-in`.

## Browser-side AEC

TTS audio plays through a local `RTCPeerConnection` loopback so the
browser's built-in echo cancellation treats it as remote audio and
subtracts it from mic input. Without this, the assistant's own voice
would trigger barge-in.

## Authentication

- **Browser users** sign in with a PIN issued at provisioning time (the
  first PIN is set during the setup wizard; subsequent users are added
  via the admin pane). The gateway exchanges the PIN for a PASETO
  v4.local session token. The web client stores the token in
  `localStorage` and sends it as `Bearer` on every subsequent request.
  Token minting, validation, and rotation live in
  `gateway/src/user-auth/`.
- **Admin endpoints** (`/api/v1/admin/*`) require the admin token minted
  at first boot. The token is shown once in the wizard and persisted to
  `~/.sentient/secrets/keys.yaml`.
- **Service-to-service** — there is no bearer-token layer between the
  gateway and STTService. STT is reachable only on the internal Docker
  network (`sentient-internal`, an internal bridge with no host port
  publication). Network isolation is the security boundary; the gateway
  is the only externally reachable service.

## State, secrets, and configuration

- `gateway/config.yaml` — operator-tunable defaults (timeouts, VAD knobs,
  TTS provider settings, logging levels). Schema is owned by
  `shared/config/`. The host overrides this file by dropping their own
  `config.yaml` at `~/.sentient/gateway/config/config.yaml`.
- Per-user behavior (chat model, persona, MCP catalog) lives in per-user
  profile directories under `profiles/<user>/{config.yaml,SOUL.md}`. The
  repository ships `profiles/example/{alice,bob}/` as templates; real
  households keep profiles under `~/.sentient/profiles/`.
- **Secrets** (provider API keys, admin token, user PIN material) live
  in `~/.sentient/secrets/keys.yaml`, written by the setup wizard
  (`gateway/src/api/wizard/`) and managed by `gateway/src/admin/secrets-store.ts`.
  Env-var fallback exists in `gateway/src/api/providers-deps.ts` for
  power users who prefer that mode, but the wizard is the supported
  path. Nothing in this tree ever needs to be committed.

## Where conversation history lives

Conversation history is persisted **inside Hermes** (chain-based,
profile-scoped). The gateway does not own it. `ConversationMirror`
(`gateway/src/cerebrum/conversation-mirror.ts`) is an ephemeral read-only
mirror used to drive SDK protocol translation and the UI's transcript
display — it is not a durable store. `TaskMirror` plays the equivalent
role for the per-cycle task table.

## Decorator-pattern pipelines

The TTS pipeline (and any future post-LLM-token pipeline) uses a
decorator-unit pattern: every stage is an `AsyncGenerator` in,
`AsyncGenerator` out. Stages compose by chaining. Each unit owns its
internal buffering. Service connection lifecycle lives in the flow
manager, not in the units.

See `.claude/rules/decorator-pattern.md` for the full rule set.

## Storage layout (host paths)

```
~/.sentient/
├── gateway/
│   ├── config/         live config.yaml (overrides repo defaults)
│   ├── data/           users.json, profiles/, archives/, install state
│   └── logs/           rotating daily log files (UTC)
├── stt-service/
│   ├── config/         STT service config.yaml
│   ├── logs/           per-day rotating logs
│   └── recordings/     optional debug PCM dumps
├── secrets/
│   └── keys.yaml       wizard-managed provider keys, admin token, etc.
├── certs/              self-signed TLS material (shared with web container)
├── run/sentient/       unix sockets for inter-container comms
└── profiles/           per-user profile YAML (real names live here, not in repo)
```

Containers mount the relevant subtrees read-write or read-only as needed.

## Where Sentient diverges from hosted real-time voice APIs

- **Dual-Pi5 split** — production runs capture and compute on separate
  boards so the mic-side stays deterministic when the LLM container is
  busy. Hosted APIs run as a single cloud process.
- **Local STT** — Silero VAD + Smart-Turn v3 + SenseVoice-Small all run
  on-device. Trade-off: client CPU + a one-time model-weights download
  vs. cloud round-trip latency + per-call price.
- **Hermes-owned per-user memory** — conversation history, profile
  memory, and tool state live inside the per-user Hermes worker. The
  gateway has no durable conversation store. Trade-off: privacy +
  per-user isolation + offline-friendly vs. harder cross-device sync.
- **Local function-call dispatch** — tool calls dispatch via standard
  MCP servers reached through the gateway or directly by Hermes. Tools
  can be local (filesystem, local services) or remote (web APIs). The
  set is operator-configured, not vendor-locked.
