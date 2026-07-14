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

    bun run dev           — Gateway + web dev servers
    bun run test          — All tests
    bun run test:unit     — Unit tests only
    bun run test:int      — Integration tests
    bun run lint          — Biome lint + format check
    bun run typecheck     — TypeScript strict check
    bun run ci            — Full local CI (lint + typecheck + test)

## Mobile build/release

    ./scripts/ios-setup.sh           — local iOS dev: debug XCFramework + generate project
    ./scripts/build-android.sh       — signed release apk (add --deploy to scp to the file server)
    ./scripts/build-ios.sh           — signed ad-hoc ipa  (add --deploy to scp to the file server)

See `docs/mobile-release.md` for one-time setup (keystore, `scripts/release.local.conf`, signing).

## Architecture

The gateway is an **ACP (Agent Client Protocol) client** that dials per-user Hermes workers. Hermes (a separate runtime, supervised by `sentient-hermes`) owns the LLM call, agent loop, tool execution, and per-user profile memory. The gateway terminates the client WebSocket, runs STT and TTS, decides WHEN to dispatch a cycle, and translates Hermes' ACP `session/update` notifications back into the SDK's wire protocol. Search / get / getMessages / delete are not covered by ACP — those route through a per-profile `hermes -p X dashboard` sidecar that mounts the bundled `sentient-plugin` REST tree at `/api/plugins/sentient-plugin/`.

Key patterns:
- Single WebSocket per client (binary audio + JSON control).
- AsyncGenerator for all streaming pipelines (STT, content-TTS, audio frames).
- **Cognitive cycle** is one Hermes round-trip identified by `cycleId`: gateway sends `user.message`, Hermes streams one or more `assistant.message` frames (intermediate narration → tool calls → final answer), terminates with `cycle.done`. Cycles are atomic — at most one active per session.
- **AttentionGate** (`gateway/src/cerebrum/attention-gate.ts`) is the only path that dispatches cycles. External stimuli during an active cycle accumulate in `ShortTermContext`; the gate fires the next cycle at natural end with everything since `lastCycleEndSeq`. ReAct continuations run back-to-back, bounded by `maxIterations`.
- Session-level cancellation is split: `bargeInController` (mic-onset → abort cycle + TTS, keep tasks) and `interruptController` (UI Stop → abort cycle + TTS + route task-cancel to Hermes).
- `ConversationMirror` and `TaskMirror` are read-only mirrors of Hermes-owned state, used for SDK protocol translation and display.
- Tool definitions live in `gateway/config.yaml#mcp_catalog` (operator-managed YAML) plus the gateway-hosted MCP server at `gateway/src/mcp-host/`. Hermes calls tools via standard MCP transport — the gateway never invokes them directly.
- Cutoff kinds on committed assistant entries: `interrupt | barge-in`.
- WebRTC loopback AEC for echo cancellation.
- Auth: PASETO v4.local for browser session tokens; service-to-service auth via the shared-token model in the `sentient-auth` package. Prompt-injection scanning + policy engine in `gateway/src/security/`.
- Per-user memory lives inside Hermes (chain-based, profile-scoped), not in the gateway.

Providers: STT via local STTService (Python service wrapping Silero VAD + Smart-Turn v3 + SenseVoice-Small); TTS via local-tts (ChatterboxTTSService, native on-host Metal/MLX, dialed over WS); LLM via Hermes worker.
Clients: Preact web (toggle-to-talk), Android (Kotlin/Compose, Phase 0 complete), iOS (Swift/SwiftUI, Phase 0 complete); both consume the shared KMP SDK (`shared/mobile-sdk`).

For PoC results and exploration details, see `docs/research/`. Anything in `docs/superpowers/` that references pre-cerebrum constructs (TurnController, ContinuousSession, InterruptionFrame, SentenceAggregator), pre-Hermes constructs (`cognitive-cycle.ts`, `effects/`, `effect-wrapper`, `EffectDispatchResult`, `SessionAudioController`, `TaskManager`, gateway-owned per-user memory), or the retired Hermes platform-adapter shape (`sentient_gateway.py`, custom-WS frames, `ConnectionPool`, `PerProfileConnection`, `WsHermesClient`) is **historical only** — those were retired in successive pivots. (Those names refer to the OLD custom-WS shape. The current ACP client has its own, unrelated `hermes-adapter-client/per-profile-connection.ts` plus a ref-counted per-user `AcpWireRegistry` wire pool — both live, not historical.)

## Learning artifacts
- Topical rules: `.claude/rules/*.md` (instructions only, ≤100 lines each)
- Topic details: `agents/docs/<topic>-details.md` (examples, gotchas)
- Active learnings: `agents/docs/learnings.md` — read this for recent discoveries
- Test procedures: `agents/docs/testing-knowledge.md`
