# Architecture

## System overview

Sentient is composed of three runtimes:

1. **Gateway** (this repository, Bun + TypeScript) — terminates client
   WebSocket connections, runs STT and TTS, hosts a small MCP server for
   gateway-side tools (`identify_user`, `pause_audio`, `resume_audio`,
   `update_user_settings`), dials Hermes for the agent loop, **and owns
   the docker-level lifecycle of every sibling container in the stack**
   (see [Gateway as system orchestrator](#gateway-as-system-orchestrator)).
2. **STT Service** (this repository, Python) — Silero VAD +
   Smart-Turn v3 turn detector + SenseVoice-Small ASR, all wrapped in a
   small WebSocket server. Local, on-device, no cloud STT call.
3. **Hermes** — a separate runtime (not in this repo) that owns the LLM
   call, agent loop, tool dispatch, and per-user profile memory. One
   `hermes -p <user>` worker per user, managed by supervisord inside the
   Sentient-built containment wrapper container `sentient-hermes` (see
   [Hermes containment wrapper](#hermes-containment-wrapper)).

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
active cycle accumulate in `Gateway`. The gate fires the next
cycle at the natural end of the current one.

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

## Gateway as system orchestrator

`sentient-gateway` is not just a WS terminator — it owns the docker
lifecycle of every sibling container: `sentient-hermes`, `stt-service`,
`egress-proxy`, `ha-mcp`, `ma-mcp`, `searxng`, `searxng-mcp`,
`fetch-mcp`. Implementation in
`gateway/src/system-orchestrator/`.

How it works:

- **Dockerode over the bind-mounted socket.** The orchestrator uses
  `dockerode` against `/var/run/docker.sock`. Socket access is granted
  via `group_add: HOST_DOCKER_GID` in the gateway compose entry — no
  host-root inside the gateway container, no `--privileged`.
- **Template-driven service catalog.** Each managed service is declared
  by a YAML template under `gateway/templates/services/*.yaml`. Templates
  carry image, networks, env, volumes, resource limits. Placeholders are
  resolved at apply time: `${SECRET}` from the secrets store,
  `${HOST_HOME}` / `${HOST_DOCKER_GID}` / `${HOST_CONFIG_DIR}` from the
  gateway-process env, and per-user dynamic values from a small set of
  registry providers.
- **Registry rebuild on every apply.** Before each `applyAll` /
  `applySubset` call, the service registry is rebuilt from disk so
  wizard / settings edits flow without a gateway restart.
- **Boot reconciler.** `reconcileOnBoot` compares the declared registry
  against actual docker state and converges (start missing,
  stop-and-replace drifted, leave matching alone). Idempotent.
- **Health probes.** Each service template carries a TCP or HTTP liveness
  probe consumed by the orchestrator's `HealthIO`. `applyAll` blocks on
  readiness up to `applyTimeoutMs`.

The orchestrator is the single audit point for "what is running and
why." Adding a new MCP, rotating an upstream image, or changing per-user
config does not require editing the compose file — it lives in templates
and per-user profile YAML.

## Hermes containment wrapper

Upstream Hermes is designed to run as a trusted host process. Its
built-in docker-backend asks the daemon to bind-mount the worker's
`HERMES_HOME` into per-task sandbox containers; on a single-user dev box
that's fine, but in a family-facing voice assistant the trust model is
wrong — a compromised tool call should not be able to write to `$HOME`.

Sentient wraps the whole Hermes runtime in a `sentient-hermes` container
built from `deploy/hermes-overlay/`. The wrap is built `FROM
nousresearch/hermes-agent:<pinned>` + `supervisor` + an ACP-over-WS
bridge (`acp_ws_server.py`) + one network-config patch. See
`deploy/hermes-overlay/README.md`.

Process model:

```
container: sentient-hermes
  └─ supervisord (PID 1, uid 10000)
       ├─ hermes-alice-acp        (port 8643 — acp_ws_server wraps `hermes -p alice acp`)
       ├─ hermes-alice-dashboard  (port 9643 — `hermes -p alice dashboard`)
       ├─ hermes-bob-acp          (port 8644)
       ├─ hermes-bob-dashboard    (port 9644)
       └─ ...
```

Per-user supervisord programs are rendered at user-add time by
`gateway/src/admin/user-provisioner.ts` + `supervisord-control.ts`. The
gateway then issues `supervisorctl reread && update` over a unix socket
shared via volume mount.

What the wrap actually contains:

- **Worker filesystem writes.** Anything the worker writes outside the
  explicit mount subtree (`~/.sentient/gateway/data` on host) dies with
  the container. Bind mounts are the audit boundary, not "wherever the
  worker happened to be running."
- **Per-task sandbox blast radius.** Hermes' docker-backend
  bind-mounts `<HERMES_HOME>/profiles/<userId>/workspace/<taskId>` into
  each spawned sandbox. The wrapper enforces `HERMES_HOME` for every
  user is a child of the gateway's data dir
  (`gateway/src/admin/user-provisioner.ts:resolveHermesHome`). Lock the
  parent, lock every sandbox.
- **Outbound network.** `HTTP_PROXY` / `HTTPS_PROXY` env in the
  container point at `egress-proxy:3128`; combined with
  `sentient-internal: internal: true`, raw outbound is impossible
  without going through tinyproxy.
- **Resource ceiling.** Memory and CPU limits applied at the container
  layer, not per-process honor system.
- **Lifecycle control.** Adding/removing a family member is a
  template-driven `supervisorctl` call from the gateway — no manual
  container surgery.

Per-user-process isolation inside the wrap (uid 10000 + supervisord +
program-scoped env) is weaker than per-container isolation; splitting
workers into per-user containers is on the hardening roadmap (see
[Honest gaps](#honest-gaps)).

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

## Security model

The security model is layered. No single control is the boundary —
network isolation + the containment wrap + the runtime defenses combine.

### Network isolation

Two docker bridges:

- `sentient-external` — only `sentient-gateway` attaches. Has the host
  route. The single externally reachable surface (one published port,
  `8888/tcp`).
- `sentient-internal` — `internal: true` on the bridge. No host gateway,
  no published ports. `sentient-hermes`, `stt-service`, all MCPs, and
  `egress-proxy` live only here. From the LAN, none of them are
  reachable.

The standard MCP posture (`agents/docs/gateway/mcp-deployment-details.md`)
forbids adding `ports:` to any MCP container — that would punch a hole
through LAN isolation.

### Egress proxy

All outbound Hermes traffic is forced through the `egress-proxy`
(tinyproxy) container via `HTTP_PROXY` / `HTTPS_PROXY` env in
`sentient-hermes`. The proxy applies a hostname denylist
(`filter.txt`, currently seeded empty — populate via StevenBlack/hosts
or incident-response notes). Allowed CONNECT ports: 443, 80, 8123 (HA),
8095 (MA).

### Hermes containment wrapper

Covered above. The wrap is the single biggest control for
agent-runtime-vs-host blast radius.

### Auth surfaces

- **Browser users** sign in with a PIN issued at provisioning time. The
  gateway exchanges the PIN for a PASETO v4.local session token. The web
  client stores the token in `localStorage` and sends it as `Bearer` on
  every subsequent request. Token minting, validation, and rotation live
  in `gateway/src/user-auth/`.
- **Admin endpoints** (`/api/v1/admin/*`) require the admin token minted
  at first boot. The token is shown once in the wizard and persisted to
  `~/.sentient/secrets/keys.yaml`.
- **Service-to-service** — there is no bearer-token layer between the
  gateway and STTService / MCPs / Hermes. The internal docker bridge IS
  the security boundary; the gateway is the only externally reachable
  service.

### Prompt-injection scanner

`gateway/src/security/injection-scanner.ts` scans inbound text against
six regex categories: `ignore_instructions`, `override_system`,
`leak_prompt`, `disobey_role`, `jailbreak_phrases`,
`inline_tool_invocation`. Findings are emitted as structured events for
the risk accumulator. The scanner does NOT block output — silent
blocking creates worse failure modes than logging and downstream policy
decisions.

### Policy engine

`gateway/src/security/policy-engine.ts` evaluates declarative rules
loaded from MCP-policy config. Each rule binds a tool match
(`tool == "<name>"` or `tool == "*"`) to a boolean condition over
`role` / `userId` / `session.channel` / `args.*` predicates, joined with
` AND ` / ` OR `. The first matching rule's action wins:
`allow` / `deny` / `confirm`. Predicates are parsed into a fixed AST —
no dynamic eval.

### Risk accumulator

`gateway/src/security/risk-accumulator.ts` runs an exponential-decay
score over weighted security events (`injection_pattern`,
`repeated_offense`, `role_violation`, `ha_name_prompt_like`,
`mutating_sensitive_domain`, `policy_rejection`). Half-life and per-event
weights are config-driven. Score thresholds map to `none` / `warn` /
`escalate` / `block` levels, consumed by the policy engine and surfaced
in logs.

### Log sanitizer

`gateway/src/logging/log-sanitizer.ts` redacts sensitive material before
any log entry is written:

- Key-based: any property key matching `token|apikey|api_key|secret|password|authorization|pin|paseto`.
- Pattern-based: PASETO v4.local tokens, `Bearer <token>`, hex-`Token <…>`,
  and `sak_<key>` (sentient-auth keys).

Every gateway log line goes through this — both file and console sinks.

### Honest gaps

The threat model isn't airtight. Tracked in `gateway/todo.md`:

- The bind-mounted `/var/run/docker.sock` in `sentient-hermes` is
  host-root-equivalent if a worker is compromised. A determined worker
  can craft `docker run -v /:/host` directly to the socket, bypassing
  Hermes' own code path. Mitigation: rootless docker / sysbox runtime.
- Per-user workers share `sentient-hermes` — user-to-user isolation is
  process-level (uid 10000 + supervisord), not container-level.
  Splitting workers into per-user containers is on the roadmap.
- `sentient-internal` allows raw-TCP between containers; a compromised
  worker can lateral-move to sibling MCPs without going through
  `egress-proxy`. Mitigation: dedicated `sentient-task` network for
  sandbox containers, iptables egress allowlist.
- The per-task sandbox image
  (`nikolaik/python-nodejs:python3.11-nodejs20`) is upstream-built, not
  Sentient-audited. Mitigation: pin a
  `ghcr.io/sentient/agent-sandbox:<tag>`.

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

- **Local STT** — Silero VAD + Smart-Turn v3 + SenseVoice-Small all run
  on-device. Trade-off: client CPU + a one-time model-weights download
  vs. cloud round-trip latency + per-call price. Main advantage is privacy.
- **Hermes-owned per-user memory** — conversation history, profile
  memory, and tool state live inside the per-user Hermes worker. The
  gateway has no durable conversation store. Trade-off: privacy +
  per-user isolation + offline-friendly vs. harder cross-device sync.
- **Local function-call dispatch** — tool calls dispatch via standard
  MCP servers reached through the gateway or directly by Hermes. Tools
  can be local (filesystem, local services) or remote (web APIs). The
  set is operator-configured, not vendor-locked.
- **Gateway-as-orchestrator + Hermes containment wrap** — see
  [Gateway as system orchestrator](#gateway-as-system-orchestrator) and
  [Hermes containment wrapper](#hermes-containment-wrapper). Hosted
  real-time APIs run a single trusted process; we run a multi-user
  family assistant where one compromised agent must not breach the
  household.
