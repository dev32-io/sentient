# Sentient

Voice gateway for a family AI assistant. Production runs on an Apple-silicon Mac mini (`deploy/mac-prod/`). The Raspberry Pi setup is retired (removed; in git history only).

## MANDATORY — Read Rules First

Rules live under root `.claude/rules/`. Cross-cutting rules sit at the top level; subproject rules nest under `.claude/rules/<subproject>/` (e.g. `.claude/rules/gateway/`, `.claude/rules/gateway/webui/`, `.claude/rules/android/`, `.claude/rules/ios/`). Each rule file declares a `paths:` glob in frontmatter; Claude Code auto-loads matching rules when you read source files.

Before exploring or modifying code, read all root rules plus the subproject rules under your target path. When a rule is unclear and you need examples, read the corresponding `agents/docs/<topic>-details.md` (cross-cutting) or `agents/docs/<subproject>/<topic>-details.md` (subproject-specific).

## Project Map

| Project | Directory | Rules | Details |
|---------|-----------|-------|---------|
| Cross-cutting | — | `.claude/rules/*.md` | `agents/docs/*-details.md` |
| Gateway | `gateway/` | `.claude/rules/gateway/*.md` | `agents/docs/gateway/*-details.md` |
| Web UI | `gateway/webui/` | `.claude/rules/gateway/webui/*.md` | `agents/docs/gateway/webui/*-details.md` |
| Android | `android/` | `.claude/rules/android/*.md` | `agents/docs/android/*-details.md` |
| iOS | `ios/` | `.claude/rules/ios/*.md` | `agents/docs/ios/*-details.md` |
| KMP Mobile SDK | `shared/mobile-sdk/` | `.claude/rules/mobile-sdk/*.md` | `agents/docs/mobile-sdk/*-details.md` |
| KMP Mobile Data | `shared/mobile-data/` | `.claude/rules/mobile-data/*.md` | `agents/docs/mobile-data/*-details.md` |
| Mobile cross-platform | `android/`, `ios/`, `shared/mobile-sdk/`, `shared/mobile-data/` | `.claude/rules/mobile/*.md` | `agents/docs/mobile/*-details.md` |
| Shared | `shared/` | (covered by cross-cutting) | — |
| Deploy | `deploy/` | (covered by cross-cutting) | — |

> **Note:** Android, iOS, mobile-sdk, mobile-data, and mobile rules are **active**. The mobile clean-architecture refactor (blackbox SDK → `mobile-data` repositories → per-screen ViewModels) is landed and ongoing.

## Shell Environment

This project requires `bun` on PATH. Before running any shell command, source the project env:

    source scripts/env.sh

All `bun run` commands, test scripts, and quality-gate hooks depend on this.

## Commands

    bun run dev           — Whole-stack launcher (gateway + webui + addons + proxy)
    bun run test          — All tests
    bun run test:unit     — Unit tests only
    bun run test:int      — Integration tests
    bun run lint          — Biome lint + format check
    bun run typecheck     — TypeScript strict check
    bun run ci            — Full local CI (lint + typecheck + test)

## Running and restarting the gateway

**Three doors, increasing fidelity.** `https://localhost` is the real one —
inbound-proxy on 443, the gateway serving the built UI behind it, identical to
prod. **All browser smoke goes here.** `http://localhost:5173` is vite, live
source with HMR, for UI iteration. `https://localhost:8888` is the gateway
direct, host-only, for diagnostics.

443 serves the bundle **as of launch**. Vite hot-reloads; 443 does not. Relaunch
to refresh it — which you want before smoking anyway, since smoke exercises the
stack as launched.

**Dev** — from the repo root:

    bun run dev             # preflight + gateway + vite + docker/native addons + proxy
    bun run stack:down      # full stop, including native addons and containers
    bun run stack:status    # what is up, probed independently of the gateway

`bun run dev` sources `scripts/env.sh` itself, builds the web UI, bakes any
missing addon images, and refuses with a runnable fix when it finds something it
must not silently repair. Re-running it against a live stack restarts it.

Ctrl-C stops the gateway and vite. Docker addons keep running (`unless-stopped`,
which is what makes restart fast) and native addons survive too — the gateway's
shutdown hook does not reap them, and the next boot's port-settle reclaims them.
`bun run stack:down` is the explicit full stop.

`bun --watch` **restarts the gateway process** on save — it does not hot-reload, and `bun --hot` must never be used here. A reload re-runs the composition root, and under `--hot` that arms a second addon supervisor inside the live process; they then reap and respawn each other's `whisper-stt` / `local-tts` children until nothing owns the ports. The gateway refuses a second in-process evaluation and exits 1 with the fix, so the failure is one legible line rather than a wedged stack. A restart re-reads `config.yaml` and the env — but `--watch` does NOT watch `config.yaml`, which is not in the module graph, so editing it needs a manual restart (touching a source file does not help either). If `:8888` is already taken, an orphaned run is the usual cause — `pkill -f "src/main.ts"`.

**Prod (the mini)** — the gateway is a **LaunchDaemon**, not a container and not a shell job. Never start it by hand:

    sudo launchctl kickstart -k system/io.sentient.gateway    # restart
    launchctl print system/io.sentient.gateway | grep -E "state|username|path"
    tail -f ~/.sentient/gateway/logs/$(date +%F).log

`RunAtLoad` + `KeepAlive` mean it starts at boot and is restarted if it exits. Upgrades go through `deploy/mac-prod/setup-prod.py`, which is health-gated and rolls back — do not swap the binary underneath a running daemon.

Auto-start at login is **not** configured, and it is not a one-line plist change: see `docs/native-todo.md` § 3 for the Docker-daemon ordering hazard.

## Mobile build/release

    ./scripts/ios-setup.sh           — local iOS dev: debug XCFramework + generate project
    ./scripts/build-android.sh       — signed release apk (add --deploy to scp to the file server)
    ./scripts/build-ios.sh           — signed ad-hoc ipa  (add --deploy to scp to the file server)

See `docs/mobile-release.md` for one-time setup (keystore, `scripts/release.local.conf`, signing).

## Gateway deploy

    ./scripts/build-gateway.sh [--release]   — compiled native binary -> dist/gateway/<version>.tar.gz
    sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<version>.tar.gz
                                              — install/upgrade; health-gated, auto-rollback on failure

Addon images (MCPs, searxng, ingress-proxy) still build via compose — see `deploy/README.md`.

## Architecture

The gateway is becoming a **native LLM orchestrator** (Sentient 2.0, in progress on `feature/native-orchestrator` — canonical design: `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md`). The gateway owns the entire agent harness — system prompt, ReAct loop, tool-call format, permission mediation, prompt caching, and compaction — calling an OpenAI-compatible LLM provider directly over HTTP. Hermes is demoted from the agent runtime to **one delegated tool** (`delegateTask(agent: "hermes", taskPrompt)`, a background tool) in a general delegation category; it no longer owns the LLM call, the agent loop, or session state.

**Deployment topology** (native-stack migration, design: `docs/superpowers/specs/2026-07-29-native-stack-migration-design.md`): the gateway itself ships as a compiled native binary (`bun build --compile`) supervised by `launchd` on the production Mac mini — it is not a Docker container. It is the **host orchestrator**: `gateway/src/system-orchestrator/` supervises docker addons (MCP tool servers, searxng, egress-proxy/ingress-proxy) and native addons (whisper-stt, local-tts) through one registry, one dependency graph, and one health model, dialing every docker addon over loopback. Hermes is never a managed service — no lifecycle, no port, no health check — it is a one-shot exec (`hermes -p <userId> -z <prompt>`), which is why the gateway and Hermes must share a filesystem. See `deploy/README.md`.

Key patterns:
- Single WebSocket per client (binary audio + JSON control).
- AsyncGenerator for all streaming pipelines (STT, content-TTS, audio frames, provider token streaming).
- **Capability-based security, four layers.** `UserPrincipal` (L0, immutable identity anchor minted once at auth) → `AccessManager` (L1, mints attenuated `Capability` tokens — the only place a principal becomes authority) → L2 resource handles (`SessionRuntime`, `FileScope`, `ToolBroker`, `ProviderClient` — hold capabilities by value, never an ambient "current user") → L3 PDP/PEP (complete mediation at every proposed tool call + argument values; fail-closed for side-effecting tools; `confirm` is a real permission prompt, not auto-approved). A model-emitted tool call is never itself an authorization decision.
- **`SessionRuntime`** — one per **`sessionId`**, with **N connections attached to it** (a session is the unit of state; a connection is a window onto it). The id is server-minted, opaque and CSPRNG — never derived from the user or the surface. It owns its own native ReAct loop, `ToolBroker` + capability, per-turn `AbortController`, and session-store handle. At most one turn runs per `SessionRuntime` at a time; a stimulus landing mid-turn steers the running loop (the next iteration re-reads the store), one landing after the final answer starts a back-to-back follow-up turn (new bubble, audio queues behind the still-playing turn). Attaching a second window never evicts the first: `session-handlers/session-registry.ts` builds the runtime on the first attachment and releases it only when the last one leaves. The retired `(userId, surfaceId)` key, and the evict-on-claim registry that enforced it, are historical — do not reintroduce either.
- **Session store** is the single source of truth: a durable, append-only, per-user local database (per §2.5/§3 of the design). It replaces the old in-memory conversation mirror — there is no separate mirror to drift out of sync. Two pure projections read it: a **model** projection (→ provider `messages[]`, cache-stable) and a **client** projection (→ SDK feed items); `render(replay) == render(live)` is a protocol-contract invariant.
- Tool definitions live in `gateway/config.yaml#mcp_catalog` (operator-managed YAML). The gateway hosts an MCP server (`gateway/src/mcp-host/`) and also runs an MCP **client** that dials those same servers as tools for its own native loop — MCP is the tool-call substrate for both directions. Every tool is foreground (fire-and-wait, awaited before the loop continues) or background (fire-and-steer, returns a `{taskId}` immediately — `delegateTask` is the archetype); a background completion arrives later as a stimulus on the same seam as a user message, never polled.
- Cancellation is two paths, both outside the loop, hitting the turn's `AbortController` directly: **barge-in** (mic onset → abort turn + TTS) and **interrupt** (UI Stop → abort turn + TTS). Cutoff kinds on committed assistant entries: `interrupt | barge-in`. **Neither cancels background work**: a background task outlives the turn that spawned it in every case and nothing cancels it — the lost-task watchdog is the only backstop, a deliberate trade until the model has a task-management tool. Session retention (`session-retention.ts`) is what keeps the store handle open so the completion can still land.
- WebRTC loopback AEC for echo cancellation.
- Auth: PASETO v4.local for browser session tokens; service-to-service auth via the shared-token model in the `sentient-auth` package. `gateway/src/security/` holds the injection scanner + risk accumulator + the inbound scanning boundary: every non-person text entering model context (MCP tool results, background-completion payloads, skill bodies, the outbound delegation prompt) crosses one gate (`inbound-gate.ts`) that runs `scanContent` (normalization + bilingual pattern bank + structural tool-envelope detection) and feeds `RiskAccumulator`; findings annotate and raise PDP risk rather than block, escalating a side-effecting tool to `confirm` at high risk. Tool-call gating is NOT among them and shares nothing with them: it is per-tool permissions (`allow|ask|deny|off`) over a role gate (`canExecute(role, tier)`), resolved at the tool boundary in `gateway/src/tools/`. The `mcp-policy.yaml` rules engine is deleted.
- **Per-user skills** (landed 2026-08-08, `docs/superpowers/specs/2026-08-08-skill-system-design.md`): a skill is a named instruction set the assistant writes for itself on request. The code module (`gateway/src/skills/`) and the five gateway-native tools (`gateway/src/tools/skill-tools.ts`: `skill_list`, `skill_use`, `skill_create`, `skill_update`, `skill_delete`) live in the code tree; the skills THEMSELVES are mutable per-user state and never do — each is a `SKILL.md` file (Agent Skills standard) under the per-user state root, `~/.sentient/gateway/users/<userId>/skills/<slug>/SKILL.md`. Lazy-loaded — a cheap `name — description` index always sits in the system prompt, the full body loads into context only when `skill_use` is called. Per-user long-term memory and recursive sub-agents remain named in the 2.0 design but out of scope for the walking skeleton.

Providers: STT via local STTService (Python service wrapping Silero VAD + Smart-Turn v3 + SenseVoice-Small); TTS via local-tts (LocalTTSService, Qwen3-TTS multilingual, native on-host Metal/MLX, dialed over WS); LLM via an OpenAI-compatible provider (OpenRouter, local Ollama) dialed directly by the orchestrator; Hermes runs natively as a local process, invoked only via `delegateTask`.
Clients: Preact web (toggle-to-talk), Android (Kotlin/Compose, Phase 0 complete), iOS (Swift/SwiftUI, Phase 0 complete); both consume the shared KMP SDK (`shared/mobile-sdk`).

For PoC results and exploration details, see `docs/research/`. Anything in `docs/superpowers/` that references pre-cerebrum constructs (TurnController, ContinuousSession, InterruptionFrame, SentenceAggregator), pre-Hermes constructs (`cognitive-cycle.ts`, `effects/`, `effect-wrapper`, `EffectDispatchResult`, `SessionAudioController`, `TaskManager`, gateway-owned per-user memory), the retired Hermes platform-adapter shape (`sentient_gateway.py`, custom-WS frames, `ConnectionPool`, `PerProfileConnection`, `WsHermesClient`), or the ACP-client cerebrum brain itself (`gateway/src/cerebrum/`, `gateway/src/hermes-adapter-client/`, `AttentionGate`, `ShortTermContext`, `ConversationMirror`, `TaskMirror`, `AcpWireRegistry`, cognitive cycles keyed by `cycleId`) is **historical only** — all retired in successive pivots, most recently the 2.0 native-orchestrator legacy purge (`10bd446`). Do not reintroduce any of these; the ACP client is gone, not merely dormant.

## Learning artifacts
- Topical rules: `.claude/rules/*.md` (instructions only, ≤100 lines each)
- Topic details: `agents/docs/<topic>-details.md` (examples, gotchas)
- Active learnings: `agents/docs/learnings.md` — read this for recent discoveries
- Test procedures: `agents/docs/testing-knowledge.md`
