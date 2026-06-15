# cycleId Render-Key Fix — Projection by entryId/seq — Design Spec

- **Date:** 2026-06-14
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Branch:** `feature/cycleid-render-projection-fix`
- **Scope:** Make `cycleId` server-unique + cycle-meta-only; re-key the client's conversation rendering off `entryId`/`seq` instead of `cycleId`. Fixes the "follow-up reply missing / previous response shown" (A) and the "scroll: bottom message stale / invisible" (B) bugs. **C/D (phantom sessions, delete) are explicitly OUT OF SCOPE.**

---

## 1. Problem

On iOS in production (prod gateway), mid-conversation:
- **A** — a follow-up message's reply is missing; the UI shows a *previous* response instead. The real reply reached the SDK (a `message.delta`/`message.done` + a committed `conversation.entry` arrived) but rendered as / collided with the prior turn's bubble.
- **B** — scrolling up makes the bottom response invisible; scrolling back down shows the previous response. A stale/duplicate row at the bottom.

Confirmed from prod logs + a 7-agent client↔gateway↔ACP investigation (2026-06-14).

## 2. Root cause

**`cycleId` is not unique, and the client uses it as the key for chat history.**

- The client-facing `cycleId` is minted by `gateway/src/cerebrum/attention-gate.ts` as `cycle-${++cycleCounter}`, where `cycleCounter` is **local to the AttentionGate instance**, and a **new AttentionGate is created on every `session.configure`** (i.e. every reconnect). So the first turn after any reconnect is **`cycle-1` again** — colliding with a `cycle-1` the client already rendered. Gateway log shows `attention-gate cycle dispatched cycleId="cycle-1" sinceSeq=0 chainLength=0` for two different turns in one session.
- The client keys **chat history** on `cycleId` in three places, so a reused id aliases turns:
  - iOS SwiftUI row id `"cyc-\(cycleId)"` (`ChatRows.swift`) — two turns sharing an id render as one row → stale/invisible bottom (B).
  - The committed-twin suppression filter `committed.filter { it.cycleId != liveCycleId }` (`ObserveChatUseCase.kt`) — drops **every** committed entry sharing the live cycle's id, so the prior turn's reply vanishes (A).
  - `ConversationHistoryConnector.kt` appends entries blindly (`mirror = mirror + enriched`) with **no `entryId` dedup** (the dedup was specced but never implemented).

`cycleId` was added for **one purpose**: a stable handle for a *turn's* transient meta (task pills, cognition status, the live in-flight bubble). It was never meant to key the committed chat sequence. A turn emits **many** committed entries (intermediate narration + each tool result + final answer — one prod turn emitted 16 entries under one cycleId), so a single cycleId can never be a correct per-row history key, even if it were unique.

## 3. Design

Two coupled changes. The client renders the conversation as a **projection over the seq-ordered server event stream, keyed by `entryId`**; `cycleId` is server-unique and used **only** for transient cycle-meta.

### 3.1 Server — `cycleId` becomes unique (one per turn)

`gateway/src/cerebrum/attention-gate.ts`: replace `generateCycleId()` (`cycle-${++cycleCounter}`) with a POSIX-millisecond id, **`String(Date.now())`**, minted at turn dispatch. One cycleId per turn; never resets across reconnect (POSIX time is monotonic across the process and turns are human-paced, so two turns never share a millisecond). The `cycleCounter` field is removed.

This alone eliminates the collision: a post-reconnect turn gets a fresh, distinct id, so it cannot alias a prior turn — benefiting even older clients that still key on `cycleId`.

`cycleId` remains a `string` on the wire (no protocol schema change); only its *value* changes from `cycle-N` to a millisecond string.

### 3.2 Client — key chat history by `entryId`/`seq`, not `cycleId`

The client already receives `entryId` on every committed entry and `seq` on every frame. It just keys the wrong field. **This is mobile-specific** — the web client (web-sdk + webui) uses `cycleId` only for cycle-meta (audio playback, task pills, live bubble) and does not key committed history on it, so it needs no render re-key (it still benefits from §3.1's server fix removing any latent collision). Changes (mobile SDK + iOS):

1. **Committed row identity** — iOS `ChatRows.swift`: committed rows key on **`"ent-\(entryId)"`** (already the fallback; promote it to primary). The transient live bubble row keeps `cycleId`.
2. **History dedup + order** — `ConversationHistoryConnector.kt`: dedup committed entries by **`entryId`** and keep **seq/arrival order** (implement the specced-but-missing dedup). A re-delivered entry (same `entryId`) updates in place rather than appending a duplicate.
3. **Live-bubble↔committed handoff** — `ObserveChatUseCase.kt`: the `committed.filter { it.cycleId != liveCycleId }` suppression stays (it hides the live turn's committed twin while the bubble streams) but is now **safe**, because `cycleId` is unique — only the *current* turn's committed entry is suppressed, never a past turn's.
4. **Live bubble accumulation** — `InFlightMessageConnector.kt`: continues to key the in-flight bubble + deltas by `cycleId`. Correct now that `cycleId` is unique.

**The handoff, stated plainly:** committed entries are the history — rendered/deduped/ordered by `entryId` in `seq` order. The streaming bubble is a transient keyed by `cycleId`; when its committed twin (same `cycleId`) arrives or `cycle.completed` fires, the transient is dropped. `cycleId` only relates a live bubble to its own turn — cycle-meta, never a history key.

### 3.3 Error handling

No new recovery logic. Reconnect recovery already re-syncs on `seq` (resume buffer + epoch); the seq cursor still dedups replays. Unknown frames are still ignored (`ServerMessage.Unknown` → no-op). Mid-stream seq-gap recovery is explicitly **not** added (out of scope; WS is TCP-ordered and reconnect-resume covers gaps).

## 4. E2E test matrix

> Driver: web → Playwright MCP; native iOS → Maestro (per `.claude/rules/e2e-testing.md`). The bug is in shared gateway (cycleId) + the per-platform render layer, so both surfaces are exercised. Run against the local macOS Docker stack.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|------------------------|--------------------|
| Two turns, no reconnect | web 1280×900 | empty chat | send msg 1, await reply; send msg 2, await reply | both replies render under their own messages; no aliasing | two distinct `cycleId` values (millisecond strings); each `conversation.entry` distinct `entryId` |
| Follow-up across reconnect (the repro) | native iOS (Maestro) | active chat, 1 completed turn | force WS reconnect (background/foreground), then send a follow-up | follow-up's reply renders correctly under the follow-up message; the previous response is NOT re-shown; nothing missing | post-reconnect turn has a **different** `cycleId` than the first; no committed entry suppressed across turns |
| Many-entry turn renders distinctly | web 1280×900 + mobile 390×844 | empty chat | send a message that triggers multiple tool calls (e.g. daily briefing) | every intermediate entry + final answer renders as its own row; no rows collapse/alias | one `cycleId` for the turn; N distinct `entryId`s; N distinct rendered rows |
| Scroll stability | native iOS (Maestro) | chat with ≥2 turns incl. a long reply | scroll up past the latest reply, then back down | the bottom reply stays visible + correct after scroll; no stale/previous row swaps in | row ids are `ent-<entryId>` (unique); no duplicate-id warnings |
| Stream→commit handoff (no double bubble) | web 1280×900 | empty chat | send a message, watch the reply stream then commit | streaming bubble grows in place, then is replaced by the committed reply with no flicker/duplicate | live bubble keyed by the turn's `cycleId`; committed twin (same cycleId) suppressed only until `cycle.completed`, then shown |

No case is skipped. (Reusable cases: extend `agents/docs/testing-knowledge.md` with the reconnect-follow-up + many-entry-render cases.)

## 5. Out of scope

- **C** (phantom "just now" sessions) and **D** (deleted session still listed) — parked by user decision; not addressed here.
- Mid-stream seq-gap recovery, protocol schema changes, ACP-layer changes.

## 6. Files touched

- `gateway/src/cerebrum/attention-gate.ts` — `generateCycleId` → `String(Date.now())`; drop `cycleCounter`.
- `shared/mobile-sdk/.../connectors/ConversationHistoryConnector.kt` — entryId dedup + order.
- `shared/mobile-sdk/.../connectors/InFlightMessageConnector.kt` — confirm cycleId-keyed live bubble (likely no change).
- `shared/mobile-data/.../usecase/ObserveChatUseCase.kt` — suppression now safe (verify, add a guard test).
- `ios/App/Chat/.../ChatRows.swift` — committed row id → `ent-<entryId>`.
- `shared/web-sdk/`, `webui/` — **no change** (web keys history correctly; `cycleId` is cycle-meta only). Covered by §3.1.
- Tests: gateway unit (cycleId unique-per-turn), mobile-sdk unit (entryId dedup, reused-cycleId no longer aliases).

## 7. Slices (for the plan)

1. **Server cycleId** — `attention-gate.ts` → `Date.now()`; unit test cycleId unique per turn.
2. **Client render re-key (mobile)** — entryId dedup (ConversationHistoryConnector), iOS row id (ChatRows), suppression-safety guard (ObserveChatUseCase); mobile-sdk unit tests for reused-cycleId-no-alias + many-entry render.
3. **E2E** — run the matrix (web Playwright + iOS Maestro) against the local stack. Web is a no-code-change regression check (confirms the server cycleId fix doesn't break web render).
