# Architecture Details — Gateway

Gateway-specific architecture details. Pairs with the cross-cutting
root: `agents/docs/architecture-details.md`.

> **Status (2026-07):** the gateway is being rebuilt as a native LLM
> orchestrator on `feature/native-orchestrator` (Sentient 2.0). The
> canonical design is
> `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md`.
> The previous ACP-client-over-Hermes brain (per-profile supervisord ACP +
> dashboard programs, `hermes-adapter-client/`, `cerebrum/`, ACP wire pool,
> `ConversationMirror`, `cycleId`) has been **deleted**, not adapted. Do not
> reintroduce it. This document describes only what Plan 1 (the foundation)
> has landed; the runtime, tools, voice, and wire are Plan 2+ and will be
> documented as they arrive.

## Identity & capability-based security (spec §2)

Ambient authority is removed: no component reads a "current user" from
module scope. Identity and authority flow only as explicit parameters.

- **L0 — `UserPrincipal`** (`gateway/src/identity/user-principal.ts`).
  Immutable `{ userId, role, householdId }`, frozen, `userId` validated by
  `assertUserId` at construction. Minted exactly once, at the auth gate
  (`session-handlers/ws-auth-gate.ts`), from a validated token, and stored on
  the socket as `SessionData.principal`. There is no rebind and no setter;
  switching accounts requires re-authenticating. The gate claims an
  `authenticating` state synchronously before any await, re-checks that claim
  after every await, and rejects cleanly (never throws) on a malformed stored
  userId — so a second in-flight auth frame cannot rebind the principal and a
  timeout cannot revive a rejected socket.
- **L1 — `AccessManager`** (`gateway/src/access/access-manager.ts`). The ONLY
  place a principal becomes authority. `grant(principal, resourceClass)` mints
  an attenuated, frozen `Capability { ownerUserId, resource, rootPath }`
  confined to `<userDataRoot>/<userId>/`.
- **L2 — resource handles hold capabilities, never the principal.**
  `FileScope` (`access/file-scope.ts`) and `SessionStore` (`store/`) accept a
  `Capability` and refuse any path outside its grant — cross-user access is
  denied by path, including reads, via `capabilityCoversPath` (a lexical
  `path.resolve` + `root + path.sep` prefix check; siblings whose name merely
  prefixes the root are correctly excluded). Physical per-user isolation
  (separate dir, separate DB file) sits underneath the code-level capability
  as defense-in-depth.
- **L3 — PDP/PEP tool-call mediation** is BUILT, in
  `gateway/src/tools/tool-broker.ts`. Every proposed tool call is mediated
  twice over: the ROLE GATE (`canExecute(capability.role, tier)`, over the
  tier the catalog declares for that tool) decides whether this person may
  reach it at all, and their PER-TOOL PERMISSION (`allow` / `ask` / `deny` /
  `off`) decides what happens when they do. The role is baked into the
  `Capability` at mint, so it cannot change under a live broker. `ask` is a
  real permission prompt, and a side-effecting tool fails closed. A
  model-emitted tool call is never itself an authorization decision.
  The security primitives in `gateway/src/security/` (injection scanner, risk
  accumulator) are a SEPARATE concern and share no code with this path — the
  declarative `mcp-policy.yaml` engine that once sat between them is deleted.

## Session store — single source of truth (spec §3)

`gateway/src/store/` — one durable, append-only SQLite DB per user
(`bun:sqlite`, WAL), opened through the user's capability so its file is
confined to their home dir.

- **Canonical entry** (`store/entry-types.ts`): `SessionEntry` with kinds
  `user | assistant | tool_call | tool_result | trigger | system |
  compaction`, each carrying a gateway-owned `created_at` (the timestamp the
  previous Hermes store never had) and a store-wide monotonic `seq`.
- **Append-only invariant.** The store's public API is append + read only —
  there is no update/delete/replace method. This keeps the model-facing prompt
  prefix byte-stable for provider prompt caching; a mutated prior entry would
  invalidate the cache from that point for the rest of the session.
- **Two pure projections read the one store** and must converge —
  `render(replay(store)) == render(live)`, pinned by
  `store/projection-convergence.test.ts`:
  - **Model** (`store/model-projection.ts`) → OpenAI `messages[]`. Emits
    complete tool round-trips, and pairs `tool_call`/`tool_result` by **block
    adjacency** (a call-run pairs only with the immediately-following
    result-run), dropping anything unmatched in either direction with a
    reason-bearing WARN — so no entry landing between a call-run and its
    result-run can produce a provider-rejected `messages[]`. Replays only from
    the latest `compaction` marker forward (to shrink LLM context).
  - **Client** (`store/client-projection.ts`) → feed items. Folds a
    `tool_call`+`tool_result` into ONE tile, renders the FULL history across
    compaction (the user never loses history because the model's context was
    compacted), and skips `system`/`compaction`. `trigger` renders as its own
    `trigger` kind (matching the shipped `conversationFeedItemSchema`), never
    as `user`.

### Constraint for the entry appender (Plan 2)

Because the model projection pairs by block adjacency, a **late / out-of-band
tool result** (e.g. a background-task completion arriving after its block) MUST
be appended as a `system` or `trigger` entry — NEVER as a second `tool_result`
for an already-answered `tool_call` id. Otherwise the model never sees it and
re-issues the call. This is recorded in the header of `store/model-projection.ts`.

## Not yet wired (Plan 2 composition root)

Plan 1 delivers the primitives; nothing constructs them at runtime yet. Before
the orchestrator loop can use them, the composition root must: add
`accessConfigSchema` + `storeConfigSchema` to `shared/config`'s
`gatewayConfigSchema` (both YAML sections are currently dropped by zod's
non-strict parse); expand the leading `~` in `access.user_data_root` at the
config-load boundary (follow `user-auth/paths.ts`'s `os.homedir()` precedent);
and thread `store.db_filename` in to replace the hardcoded constant. These are
tracked in the Plan 1 progress ledger.
