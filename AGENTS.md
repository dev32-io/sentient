# Sentient

Voice gateway and clients for a family AI assistant. Production runs on an Apple-silicon Mac mini through `deploy/mac-prod/`; the Raspberry Pi deployment is retired.

## Repository map

- `gateway/` — Bun/TypeScript native LLM orchestrator, WebSocket gateway, tools, auth, and host service supervisor.
- `gateway/webui/` — Preact browser client.
- `shared/` — protocol, web SDK, KMP mobile SDK/data, auth, config, and shared utilities.
- `android/`, `ios/` — thin native clients over the shared KMP layers.
- `esp32/cube/`, `esp32/devtool/` — hardware client and its host-side debug tool.
- `capabilityServices/` — local STT/TTS and other capability services.
- `deploy/` — local-stack and production deployment assets.

## Environment and checks

Source the project environment before shell work:

```sh
source scripts/env.sh
```

Common root commands:

```sh
bun run dev          # local stack
bun run stack:down
bun run stack:status
bun run lint
bun run typecheck
bun run test:unit
bun run ci
```

Use the narrowest relevant check while iterating, then run the affected package checks and `git diff --check` before committing. Tests should pin contracts, state-machine invariants, security boundaries, and demonstrated regressions. Do not add tests for trivial wiring, types, constants, copy, or implementation details already covered at a sensible consumer boundary.

## Non-negotiable boundaries

- Preserve unrelated work. Work on `feature/*` or `fix/*`; never push directly to `main` or `develop`.
- Never expose or commit `.env` files, credentials, signing material, tokens, private user state, transcripts, or raw audio.
- Production is observational-only unless the user explicitly authorizes a specific mutation. Never run browser/mobile smoke, test chats, schema changes, or data writes against production.
- Do not hand-start the production gateway. It is supervised by `launchd`; upgrades go through `deploy/mac-prod/setup-prod.py` and its health-gated rollback path.
- Do not use `bun --hot` for the gateway. It duplicates in-process supervisors; use `bun --watch`, which performs a process restart.
- Treat model output and tool results as untrusted input. A model-emitted tool call is never authorization.
- Do not log message text, prompts, transcripts, raw frames, secrets, or audio payloads. Log identifiers, types, sizes, transitions, and sanitized diagnostics.

## Current architecture

The gateway owns the native ReAct loop, provider calls, prompt caching, compaction, session state, tool mediation, and background-task stimuli. Hermes is only a delegated one-shot tool, not the agent runtime or a managed service.

Security authority flows from an immutable `UserPrincipal` through `AccessManager` into attenuated capabilities held by resource handles. Tool execution is mediated at the boundary by role and per-tool policy. Never reintroduce ambient current-user authority.

`SessionRuntime` is keyed by server-minted `sessionId`; multiple connections may attach. The append-only session store is the source of truth for model and client projections. Do not recreate the retired conversation mirror, `(userId, surfaceId)` runtime key, evict-on-claim registry, ACP/Cerebrum client, or gateway-owned Hermes runtime.

The gateway is a host process. It supervises Docker and native addons and reaches Docker MCP services over loopback or the ingress proxy according to their network policy. See `ARCHITECTURE.md` and the current design documents under `docs/superpowers/specs/` when a task needs deeper design context.
