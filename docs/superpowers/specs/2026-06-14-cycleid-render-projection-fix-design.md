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

**Most of the mobile render is correct once `cycleId` is unique (§3.1) — no logic change.** Reading the code, two render keys deliberately use `cycleId` for the live-bubble↔committed handoff, and they were buggy *only* because the id collided across turns:

- `ChatRows.swift` keys the assistant row by `cycleId`-first **on purpose**: the live streaming bubble and its committed twin share the turn's `cycleId` so the streaming→committed handoff is the **same SwiftUI row — no remount/flash**. A turn emits exactly **one** assistant committed entry (tool/user/REST entries already key by `entryId`), so with a unique `cycleId` this is distinct per turn → no collision. **Keep as-is** — switching it to `entryId` would re-introduce a remount flash for no benefit.
- `ObserveChatUseCase.kt`'s `committed.filter { it.cycleId != liveCycleId }` suppression: with a unique `cycleId` it drops only the *current* turn's one assistant entry → already correct. **Keep as-is.**

The one real client change, plus guard tests:

1. **History dedup** — `ConversationHistoryConnector.kt#onEntryFrame`: today it appends blindly (`mirror = mirror + enriched`). Dedup by **`entryId`** — a re-delivered entry (same `entryId`, e.g. a replayed committed entry on resume) updates **in place** instead of appending a duplicate. (Fixes a separate replay-duplicate defect and realises the "clean projection" principle; the `entryId` field exists for exactly this and was never used.)
2. **Guard tests** — pin that the server fix holds end-to-end on the client: (a) `ChatRows` — two messages with **distinct** `cycleId`s produce **distinct** row ids (no alias); (b) `ObserveChatUseCase` — with a unique live `cycleId`, only the live turn's committed entry is suppressed, a prior turn's entry stays visible; (c) `ConversationHistoryConnector` — a duplicate `entryId` does not double-append.

**The model, stated plainly:** committed entries are the history — keyed/deduped by `entryId` in `seq` order. The streaming bubble is transient; it shares its turn's unique `cycleId` with that turn's one committed assistant entry purely to make the handoff a smooth in-place row update. `cycleId` never keys *arbitrary* history — only a turn's own live↔committed pair (cycle-meta).

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

- `gateway/src/cerebrum/attention-gate.ts` — `generateCycleId` → `String(Date.now())`; drop `cycleCounter`. **(logic change)**
- `shared/mobile-sdk/.../connectors/ConversationHistoryConnector.kt` — `onEntryFrame` entryId dedup (replace-in-place). **(logic change)**
- `ios/App/Chat/message/ChatRows.swift` — **no logic change** (cycleId-first handoff is correct once cycleId is unique); add a guard test that distinct cycleIds → distinct row ids.
- `shared/mobile-data/.../usecase/ObserveChatUseCase.kt` — **no logic change** (suppression correct with unique cycleId); add a guard test (prior-turn entry not suppressed).
- `shared/mobile-sdk/.../connectors/InFlightMessageConnector.kt` — no change.
- `shared/web-sdk/`, `webui/` — **no change** (web keys history correctly; `cycleId` is cycle-meta only). Covered by §3.1.
- Tests: gateway unit (cycleId unique-per-turn / no reset across gate re-creation); mobile-sdk unit (entryId dedup no double-append, ChatRows distinct-cycleId no-alias, ObserveChatUseCase prior-turn-not-suppressed).

## 7. Slices (for the plan)

1. **Server cycleId** — `attention-gate.ts` `generateCycleId` → `String(Date.now())`, drop `cycleCounter`; gateway unit test (unique per turn / no reset across gate re-creation).
2. **Client dedup + guard tests** — `ConversationHistoryConnector` entryId dedup (logic) + dedup test; `ChatRows` distinct-cycleId-no-alias guard test (no logic change); `ObserveChatUseCase` prior-turn-not-suppressed guard test (no logic change).
3. **E2E** — run the matrix (web Playwright + iOS Maestro) against the local stack. Web is a no-code-change regression check (confirms the server cycleId fix doesn't break web render).
