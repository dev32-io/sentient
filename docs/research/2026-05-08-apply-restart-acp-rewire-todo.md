# Apply / Restart Paths — ACP Rewire TODO

**Status:** open. Filed during the Phase 7 ACP cleanup as a known gap.
Not blocking the merge — these paths were already pre-existing-broken
under ACP before the cleanup (the legacy custom-WS endpoint they leaned
on was already gone). They are stubbed with WARN logs that point back
to this doc.

## Background

The retired custom-WS adapter (`sentient_gateway.py`) exposed a long-lived
`/ws` endpoint per profile. The Bun gateway maintained one pooled
WebSocket connection per active user (`ConnectionPool` +
`PerProfileConnection`) so it could:

1. Probe **dispatch readiness** at user-creation time via a ping/pong
   round-trip on the pool (`waitForPingPong`).
2. Fire `/reset` as an internal user message after `apply` / restart so
   Hermes rotated `session_id` and rebuilt the system_prompt from the
   freshly-rendered config on the next user turn.
3. Re-fire `/personality <name>` as an internal user message after a
   profile restart so Hermes' agent slot picked the active personality
   back up before the next user turn.
4. Subscribe to per-profile WS events (e.g. compression auto-split
   `session.created` / `session.switched` frames) and forward them to
   the SDK.

Under the ACP wire, **none of those paths have a direct equivalent**:

- ACP defines `session/new`, `session/list`, `session/prompt`,
  `session/cancel`. There is no "internal slash command" path. `/reset`
  has no protocol-level equivalent today.
- Per-profile `acp_ws_server.py` exposes `/healthz` and `/acp` only —
  no `/ws`, no eager pool to attach to. Each gateway WS-session
  bootstraps its own ACP connection on demand.
- ACP `session/update` notifications cover assistant chunks, tool
  events, and our custom `sessions.renamed` / `commands.available`
  extensions. Compression-driven session rotation is not currently
  surfaced.

## Stubbed call sites (Phase 7)

The following modules used to depend on the pool. They were retained
with WARN logs and TODO comments pointing here. Each is a no-op or a
silent-skip until the ACP-side equivalents are wired:

- `gateway/src/admin/dispatch-reset.ts` — entire module. Call sites in
  `apply/orchestrator.ts` and `admin/profile-restart-orchestrator.ts`
  log `*.reset-skipped-acp-no-equivalent`.
- `gateway/src/admin/profile-restart-orchestrator.ts` — dropped the
  `closing-ws → polling-WS-ready` phases. The orchestrator now calls
  supervisord, fires the no-op `dispatchReset`, logs
  `restart.ready-without-ws-probe`, and returns ready optimistically.
  Polling-related config keys (`pollIntervalMs`) stayed on the type so
  callers compile against the same shape.
- `gateway/src/bootstrap/phase-services.ts#buildBootstrapWorker` —
  dropped pool upsert + `waitForPingPong`. Strict-mode account
  creation now relies on supervisord RUNNING + `/healthz` 200 to
  declare warm; logs `createUser.dispatch-ready-without-acp-probe`.
- `gateway/src/api/handlers/profile-edit-personalities.ts` —
  `dispatchActivePersonality` is a logged no-op
  (`active.skipped-acp-no-equivalent`). The personality file still
  lands on disk via `personality-store`, so the next fresh session
  picks it up.
- `gateway/src/api/handlers/profile-edit.ts#reapplyActivePersonality`
  — same story; logs `reapplyActive.skipped-acp-no-equivalent`.

## Practical user-visible effect

After `apply` (model / persona / SOUL.md edit) or a personality CRUD
restart, **the existing chat session keeps its cached system_prompt
until session compression eventually rotates it.** Operators who want
the new config to take effect immediately can `+ New chat` from the
drawer.

For account creation: the per-user worker is reported "ready" after
`/healthz` 200, even if the actual ACP endpoint is wedged. The first
user message proves dispatch end-to-end.

## What needs to be wired (when time permits)

1. **ACP-side equivalent of `/reset`.** Either an upstream protocol
   extension (preferred — coordinate with the ACP spec) or a
   sentient-plugin custom RPC. Hooks: `apply/orchestrator.ts:148`,
   `admin/profile-restart-orchestrator.ts:81`.
2. **ACP-side equivalent of `/personality <name>`.** Same pattern as
   reset — either a protocol extension or a sentient-plugin RPC.
   Hooks: `api/handlers/profile-edit-personalities.ts:65` and
   `api/handlers/profile-edit.ts:248`.
3. **Eager dispatch-readiness probe.** At user creation time
   (`buildBootstrapWorker` strict mode), open a one-shot ACP
   connection, run `initialize` + a no-op `session/list` round-trip,
   confirm the worker accepts dispatches before returning. Hooks:
   `bootstrap/phase-services.ts:312`.
4. **Connected-state observability for the restart orchestrator.**
   After `supervisord restart` returns, poll the per-profile `/healthz`
   + a one-shot ACP `initialize` until both succeed (or timeout) before
   reporting ready. Today's optimistic ready can mask a wedged worker
   that the next WS-session bootstrap then fails on. Hooks:
   `admin/profile-restart-orchestrator.ts:75`.
5. **Forward Hermes-initiated session lifecycle frames.** When
   compression auto-split or any other server-side rotation lands in
   ACP, route it through `acpConn.onEvent` to the SDK as
   `session.switched` + `conversation.snapshot` (the legacy
   `pooled.subscribe(translateHermesFrame)` listener was retired in
   Phase 7). Hooks: `session-handlers/ws-session-configure.ts`.

## Estimating the work

Items 1–2 are the hard ones — they require either upstream ACP
coordination or a sentient-plugin RPC + matching gateway call site.
Items 3–4 are wholly within this repo, blocked only on items 1–2 if we
want strict-mode to verify dispatch end-to-end (otherwise just probe
`initialize` and trust the upstream `acp` agent).

Each chunk has its own spec + smoke matrix; do not bundle them with
unrelated feature work.
