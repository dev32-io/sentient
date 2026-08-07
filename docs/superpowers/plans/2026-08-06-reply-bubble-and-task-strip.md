# Reply Bubble + Composer Task Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One model reply renders as exactly one bubble — live, committed, and on replay — and tool activity moves out of the chat feed into a server-authoritative task strip above the composer.

**Architecture:** The gateway remains the only authority for where a reply starts and stops. The store keeps writing one entry per text stretch (the model projection needs text interleaved with tool calls in dispatch order), but the CLIENT projection folds consecutive assistant entries that share a `replyId` into one feed item. Tool tiles leave the conversation feed entirely; a per-session `TaskListProjector` owns the live tool/task list and publishes it as one idempotent full-state frame (`tasklist.state`) on the session lane. Every client becomes a dumb renderer: no merging, no anchoring, no lifetime reasoning.

**Tech Stack:** Bun + TypeScript (gateway), zod (`shared/protocol`), Preact + signals (`gateway/webui`), TypeScript (`shared/web-sdk`), Kotlin Multiplatform (`shared/mobile-sdk`, `shared/mobile-data`), SwiftUI (`ios/App`), Jetpack Compose (`android/src/main/kotlin`), Maestro (native e2e), Playwright MCP (web e2e).

## Global Constraints

- Work on branch `feature/native-orchestrator`. Never push to `main` or `develop`.
- Source the project env before ANY shell command: `source scripts/env.sh`.
- Gateway unit tests run under **`bun test`** from `gateway/src` (`cd gateway/src && bun test`), NOT vitest. Web/webui/SDK tests run under vitest via `bun run test`.
- The name is **`replyId`** everywhere — store column `reply_id`, TS/Kotlin/Swift field `replyId`, wire field `replyId`. `messageId` is retired; zero occurrences may remain outside git history.
- `STORE_DDL` in `gateway/src/store/schema.ts` is FROZEN. New columns go in `STORE_MIGRATIONS` only (see that file's header). Next free version is **4**.
- Every new file imports a tagged logger (`getLog([...])` in gateway, `createLogger([...])` in web-sdk, `createLogger(...)` in mobile-sdk). No bare `console.*`.
- Mobile logging must never emit user content at any level — lengths, ids and types only (`PrivacyGuardTest` enforces this). `argsPreview` is user content.
- Tunables go in `gateway/config.yaml` with an inline comment, never as inline literals.
- `commonMain` in mobile-sdk/mobile-data must not import platform APIs; inject a `Clock`, never call a wall clock directly.
- Do not run Playwright or Maestro against production (`mini0.lan` / `sentient.dev32.io`). Local stack only.
- Commit after every task with a `type(scope): description` message.

---

## File Structure

**Gateway — modified**

| Path | Responsibility after this plan |
|---|---|
| `gateway/src/store/schema.ts` | + migration v4 `entries.reply_id` |
| `gateway/src/store/entry-types.ts` | `SessionEntry.replyId` |
| `gateway/src/store/session-store.ts` | reads/writes `reply_id` |
| `gateway/src/store/client-projection.ts` | folds a reply into ONE item; no tool items |
| `gateway/src/runtime/conversation-feed.ts` | holds back the OPEN reply; no tool hold-back |
| `gateway/src/runtime/session-runtime.ts` | mints/rotates `replyId`; owns the `TaskList` |
| `gateway/src/runtime/react-loop.ts` | stamps `replyId` on assistant entries |
| `gateway/src/runtime/turn-emitter.ts` | `textDelta(…, replyId?)`, `conversationEntry(…, replyId?)`, + `taskList(…)` |
| `gateway/src/session-handlers/ws-turn-emitter.ts` | emits `tasklist.state`; `turn.tool.update` retired in Task 15 |
| `gateway/src/session-handlers/frame-lanes.ts` | + `tasklist.state`: session |

**Gateway — created**

| Path | Responsibility |
|---|---|
| `gateway/src/runtime/task-list.ts` | `TaskListProjector` — pure, per-session, owns the live task list and its lifetime |
| `gateway/src/runtime/task-list.test.ts` | pins the lifetime rules (turn boundary drops foreground, keeps background) |

**Protocol — modified**

| Path | Responsibility |
|---|---|
| `shared/protocol/src/conversation.ts` | assistant item gains `replyId`; tool item retired in Task 15 |
| `shared/protocol/src/messages.ts` | `turn.text.delta.replyId`, `conversation.entry.replyId`, + `tasklist.state` |

**Web** — `shared/web-sdk/src/connectors/task-list-connector.ts` (new), `inflight-message-connector.ts`, `conversation-history-connector.ts`; `gateway/webui/src/components/dock/composer-task-strip.tsx` (new), `composer.tsx`, `app.tsx`, `hooks/cycle-helpers.ts`, `hooks/use-voice-client.ts`, `types.ts`, `components/chat/message-bubble.tsx`, `styles/components.css`.

**Mobile shared** — `shared/mobile-sdk/.../connectors/TaskListConnector.kt` (new), `protocol/ServerMessage.kt`, `protocol/ConversationFeedItem.kt`, `protocol/SdkEvent.kt`, `sdk/SdkState.kt`, `sdk/StateDeriver.kt`, `sdk/SdkConnectors.kt`, `connectors/InFlightMessageConnector.kt`, `connectors/ConversationHistoryConnector.kt`; `shared/mobile-data/.../usecase/RevealReducer.kt`, `usecase/ObserveChatUseCase.kt`, `model/ChatModel.kt`.

**Native UI** — `ios/App/Chat/composer/ComposerTaskStrip.swift` (new), `composer/Composer.swift`, `message/MessageBubble.swift`, `tool/ToolPillStrip.swift` (moves), `ChatView.swift`; `android/src/main/kotlin/io/sentient/android/chat/composer/ComposerTaskStrip.kt` (new), `composer/Composer.kt`, `message/MessageBubble.kt`, `tool/ToolPillStrip.kt` (moves), `ChatContent.kt`.

---

# Slice A — One reply, one bubble

The red test that gates this slice already exists: `gateway/src/runtime/reply-bubble-convergence.test.ts`.

---

### Task 1: Rename `messageId` → `replyId` in the store and gateway runtime

Mechanical rename plus a schema migration. No behaviour change — the fold arrives in Task 3.

**Files:**
- Modify: `gateway/src/store/schema.ts` (add migration v4)
- Modify: `gateway/src/store/entry-types.ts:38`, `:68`
- Modify: `gateway/src/store/session-store.ts:48` (`EntryRow`), `:66` (`toEntry`), and the INSERT around `:190`
- Modify: `gateway/src/runtime/session-runtime.ts:318`, `:325`, `:811`, `:829`, `:861`, `:945-952`
- Modify: `gateway/src/runtime/react-loop.ts:98`, `:153`, `:571`, `:606`
- Modify: `gateway/src/runtime/turn-emitter.ts:45`, `:73`, `:112-118`, `:141-147`
- Modify: `gateway/src/runtime/conversation-feed.ts:69`, `:209-212`, `:223-227`, `:277`
- Modify: `gateway/src/session-handlers/ws-turn-emitter.ts:117`, `:125`, `:197`
- Modify: `shared/protocol/src/messages.ts:442` (`turn.text.delta`), `:598` (`conversation.entry`)
- Test: `gateway/src/store/session-store.test.ts`, `gateway/src/store/client-projection.test.ts`, `gateway/src/store/model-projection.test.ts`, `gateway/src/store/projection-convergence.test.ts`, `gateway/src/store/pending-id-scope.test.ts`, `gateway/src/runtime/turn-state-snapshot.test.ts`, `gateway/src/runtime/compaction.test.ts`, `gateway/src/runtime/react-loop.test.ts`, `gateway/src/runtime/conversation-feed.test.ts`, `gateway/src/runtime/titler.test.ts`, `gateway/src/session-handlers/session-id.test.ts`, `gateway/src/session-handlers/ws-session-configure.test.ts`, `gateway/src/api/handlers/sessions.test.ts`, `gateway/src/tools/background-completion-note.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionEntry.replyId: string | null`; `TurnEmitter.textDelta(turnId: string, text: string, replyId?: string): void`; `TurnEmitter.conversationEntry(item: ConversationFeedItem, turnId?: string, replyId?: string): void`; wire fields `turn.text.delta.replyId?: string` and `conversation.entry.replyId?: string`.

- [ ] **Step 1: Add the schema migration**

In `gateway/src/store/schema.ts`, append to `STORE_MIGRATIONS` after the `version: 3` entry:

```ts
  {
    version: 4,
    name: "entries.reply_id",
    statements: [
      // WHICH REPLY an entry is part of. Renamed from `message_id` (v3):
      // `messageId` on an entry read as "this entry's id", which is exactly
      // wrong — it is the id of the thing the entry BELONGS TO. One reply is
      // several entries (a ReAct turn narrates, calls a tool, then answers)
      // and they fold into one bubble on the client projection.
      //
      // Copy-then-drop rather than a bare rename: SQLite's RENAME COLUMN
      // landed in 3.25 and bun:sqlite ships newer, but the copy keeps the
      // ladder readable and leaves the v3 databases' data intact.
      "ALTER TABLE entries ADD COLUMN reply_id TEXT",
      "UPDATE entries SET reply_id = message_id WHERE message_id IS NOT NULL",
      "ALTER TABLE entries DROP COLUMN message_id",
    ],
  },
```

- [ ] **Step 2: Write the failing migration test**

Create `gateway/src/store/schema-migration-v4.test.ts`:

```ts
import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { migrateStore } from "./migrate-store.js";
import { STORE_DDL, STORE_MIGRATIONS, STORE_SCHEMA_VERSION } from "./schema.js";

const ROOT = "/tmp/sentient-schema-v4-test";
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function columns(db: Database): string[] {
  return db.query<{ name: string }, []>("PRAGMA table_info(entries)").all().map((r) => r.name);
}

describe("store migration v4", () => {
  it("carries message_id values onto reply_id and drops the old column", () => {
    const db = new Database(`${ROOT}/v3.db`);
    db.exec(STORE_DDL);
    // Bring the database to v3 only, then seed a row the old way.
    for (const m of STORE_MIGRATIONS) {
      if (m.version > 3) continue;
      for (const s of m.statements) db.exec(s);
    }
    db.exec("PRAGMA user_version = 3");
    db.exec(
      "INSERT INTO entries (session_id, turn_id, kind, created_at, text, message_id) VALUES ('s1','t1','assistant',1,'hi','r1')",
    );

    expect(migrateStore(db, "u_test")).toBe(STORE_SCHEMA_VERSION);
    expect(columns(db)).toContain("reply_id");
    expect(columns(db)).not.toContain("message_id");
    const row = db.query<{ reply_id: string | null }, []>("SELECT reply_id FROM entries").get();
    expect(row?.reply_id).toBe("r1");
    db.close();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
source scripts/env.sh && cd gateway/src && bun test store/schema-migration-v4.test.ts
```
Expected: FAIL — `reply_id` is not in the column list (the migration does not exist yet). If you added Step 1 first, this step passes immediately; that is fine, note it and continue.

- [ ] **Step 4: Rename the field everywhere**

`gateway/src/store/entry-types.ts` — replace the `messageId` field and its doc block:

```ts
  /**
   * WHICH REPLY this entry is part of — the unit the person sees as one bubble.
   *
   * A turn is an interaction; a reply is what the assistant said. Usually the
   * same thing, but a ReAct turn narrates, calls a tool, then answers, and each
   * stretch of text is its own entry — so one turn owns several and they fold
   * into ONE item on the client projection. Grouping by `turnId` alone cannot
   * express the exception: a message the person sends mid-turn renders as its
   * own row between two of those stretches, and everything after it is a NEW
   * reply.
   *
   * Server-minted. Null on `user`/tool entries, and on any assistant entry
   * written before the column existed — those render one bubble each, which is
   * how they already looked.
   */
  replyId: string | null;
```

and in `sessionEntrySchema`: `replyId: z.string().nullable(),`.

`gateway/src/store/session-store.ts` — `EntryRow.message_id` becomes `reply_id`; `toEntry` maps `replyId: row.reply_id`; the INSERT statement's column list and the bound value change from `message_id`/`entry.messageId` to `reply_id`/`entry.replyId`.

In `session-runtime.ts`, `react-loop.ts`, `turn-emitter.ts`, `conversation-feed.ts`, `ws-turn-emitter.ts`: rename every identifier `messageId` → `replyId`, `currentMessageId` → `currentReplyId`, `messageIdBySeq` → `replyIdBySeq`, and the log event `session-runtime.message.rotated` → `session-runtime.reply.rotated` with keys `previousReplyId` / `replyId`. Update the surrounding comments to say "reply" where they said "message"/"bubble key".

In `shared/protocol/src/messages.ts` rename both `messageId` fields to `replyId`, and reword their doc comments to "WHICH REPLY this delta belongs to" / "The reply this entry is part of".

- [ ] **Step 5: Update every gateway test that names the old field**

```bash
source scripts/env.sh && rg -l 'messageId|message_id|currentMessageId' gateway/src shared/protocol/src
```
Rename in each hit. There must be zero remaining hits when you are done.

- [ ] **Step 6: Run the gateway suite**

```bash
source scripts/env.sh && cd gateway/src && bun test
```
Expected: everything passes EXCEPT `runtime/reply-bubble-convergence.test.ts`, which still fails on both cases (`live` is 1 item, `committed` is 3; no `replyId` on the item). That is the bug this slice fixes — do not touch that file.

- [ ] **Step 7: Typecheck and commit**

```bash
source scripts/env.sh && bun run typecheck
git add -A && git commit -m "refactor(store): name the bubble key replyId, because an entry belongs to a reply"
```

---

### Task 2: Carry `replyId` on the assistant feed item

The `conversation.entry` FRAME already carries it; `conversation.snapshot` and `GET /sessions/:id/messages` carry items only, so a window that attaches mid-turn cannot tell which committed row its live bubble is painting.

**Files:**
- Modify: `shared/protocol/src/conversation.ts:70-76` (`conversationFeedAssistantItemSchema`)
- Modify: `gateway/src/store/client-projection.ts` (`FeedItem` gains `replyId`)
- Modify: `gateway/src/runtime/conversation-feed.ts` (`toWireItem` copies it through)
- Test: `gateway/src/runtime/reply-bubble-convergence.test.ts` (case 2 goes green)

**Interfaces:**
- Consumes: `SessionEntry.replyId` (Task 1).
- Produces: `ConversationFeedItem` of `kind:"assistant"` gains `replyId?: string`; `FeedItem.replyId: string | null`.

- [ ] **Step 1: Add the wire field**

`shared/protocol/src/conversation.ts`:

```ts
export const conversationFeedAssistantItemSchema = z.object({
  entryId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal("assistant"),
  /** WHICH REPLY this item is. Carried on the ITEM, not only on the
   *  `conversation.entry` frame: a window that attaches mid-turn is answered
   *  with a snapshot, which has no frame to hang it on, and without it that
   *  window cannot tell which committed row its live bubble is painting. */
  replyId: z.string().optional(),
  content: z.string(),
  cutoff: conversationAssistantCutoffSchema.optional(),
});
```

- [ ] **Step 2: Carry it through the projection**

`gateway/src/store/client-projection.ts` — add to `FeedItem`:

```ts
  /** The reply this item belongs to; null on user/trigger items. */
  replyId: string | null;
```

Set `replyId: null` in the tool-item push, and `replyId: entry.replyId` in the final `items.push({ ... })` for user/trigger/assistant.

`gateway/src/runtime/conversation-feed.ts` — in `toWireItem`, the `"assistant"` case becomes:

```ts
    case "assistant":
      return {
        ...base,
        kind: "assistant",
        content: item.text,
        ...(item.replyId === null ? {} : { replyId: item.replyId }),
        ...(item.cutoff === null ? {} : { cutoff: toWireCutoff(item.cutoff) }),
      };
```

- [ ] **Step 3: Run the repro test**

```bash
source scripts/env.sh && cd gateway/src && bun test runtime/reply-bubble-convergence.test.ts
```
Expected: case 2 (`carries the bubble key on every committed assistant item`) PASSES. Case 1 still FAILS — `committed` is 3 items, `live` is 1.

- [ ] **Step 4: Commit**

```bash
source scripts/env.sh && cd gateway/src && bun test && cd ../.. && bun run typecheck
git add -A && git commit -m "feat(protocol): carry replyId on the assistant item, not only the entry frame"
```

---

### Task 3: Fold one reply into one feed item

**Files:**
- Modify: `gateway/src/store/client-projection.ts`
- Modify: `gateway/src/runtime/conversation-feed.ts`
- Modify: `gateway/src/runtime/session-runtime.ts` (pass `currentReplyId` to the feed)
- Test: `gateway/src/runtime/reply-bubble-convergence.test.ts`, `gateway/src/store/client-projection.test.ts`, `gateway/src/store/projection-convergence.test.ts`, `gateway/src/runtime/conversation-feed.test.ts`

**Interfaces:**
- Consumes: `FeedItem.replyId` (Task 2).
- Produces: `ConversationFeedDeps` gains `currentReplyId: () => string | null`. A folded assistant item's `entryId` is its `replyId`.

- [ ] **Step 1: Fold in the client projection**

In `gateway/src/store/client-projection.ts`, replace the final `items.push({ ... })` block with a fold. Insert before the push:

```ts
    // ONE REPLY, ONE ITEM. The store records a reply as several entries — a
    // ReAct turn narrates, calls a tool, then answers, and each stretch is its
    // own row so the MODEL projection can interleave them with the tool calls
    // in dispatch order. The person saw one bubble that grew. Folding here, at
    // the single path from stored state to a feed item, is what makes the
    // committed feed agree with the live stream instead of asking three
    // clients to re-derive the grouping and disagree about it.
    //
    // Consecutive only: anything between two stretches (a mid-turn user row)
    // means the gateway already rotated the replyId, so they never fold.
    if (kind === "assistant" && entry.replyId !== null) {
      const previous = items[items.length - 1];
      if (previous !== undefined && previous.kind === "assistant" && previous.replyId === entry.replyId) {
        items[items.length - 1] = {
          ...previous,
          text: previous.text + (entry.text ?? ""),
          cutoff: entry.cutoff ?? previous.cutoff,
        };
        continue;
      }
    }
```

and in the push itself, give a folded assistant item its reply's identity:

```ts
    items.push({
      // A reply's identity is its replyId, not the seq of whichever stretch
      // happened to be last: a window that attaches mid-turn projects the
      // reply so far, and the same reply must keep the same id when it grows,
      // or the client's dedupe-by-entryId appends a second bubble.
      id: kind === "assistant" && entry.replyId !== null ? entry.replyId : String(entry.seq),
      kind,
      text: entry.text ?? "",
      toolName: null,
      cutoff: entry.cutoff,
      createdAt: entry.createdAt,
      replyId: entry.replyId,
      pendingId: entry.pendingId === null ? null : unscopePendingId(entry.pendingId),
    });
```

- [ ] **Step 2: Hold back the OPEN reply in the feed**

A reply is not content-final until it closes (turn end, or a steer rotating the id). `conversation-feed.ts` already has exactly this machinery for tool tiles — reuse its shape.

In `ConversationFeedDeps`, add:

```ts
  /** The replyId the runtime is currently writing into, or null when no turn
   *  is in flight. An item carrying it is still GROWING and must not publish:
   *  the client appends `conversation.entry` to its mirror, so an item emitted
   *  before its content settles is a permanently stale bubble. */
  readonly currentReplyId: () => string | null;
```

In `publish(force)`, replace the tool hold-back predicate with a reply hold-back:

```ts
    const openReplyId = force ? null : deps.currentReplyId();

    let published = 0;
    let heldBackAtSeq: number | null = null;
    for (const item of projectForClient(tail)) {
      const isUnresolvedTool = unresolved.has(item.id);
      const isOpenReply = openReplyId !== null && item.replyId === openReplyId;
      if ((isUnresolvedTool || isOpenReply) && !force) {
        heldBackAtSeq = firstSeqOf(tail, item);
        break;
      }
      emitter.conversationEntry(toWireItem(item, isUnresolvedTool), turnIdBySeq.get(item.id), item.replyId ?? undefined);
      published += 1;
    }
```

`item.id` is no longer always a seq, so add the helper above `createConversationFeed`:

```ts
/** The seq the cursor must park just below to re-read [item] next publish.
 *  A folded assistant item's id is its replyId, so its seq is the FIRST entry
 *  of the fold — parking below that is what makes the next publish see the
 *  whole reply again rather than only its tail. */
function firstSeqOf(entries: readonly SessionEntry[], item: FeedItem): number {
  if (item.replyId !== null) {
    for (const e of entries) if (e.replyId === item.replyId) return e.seq;
  }
  return Number(item.id);
}
```

Replace `turnIdBySeq.get(item.id)` lookups accordingly: build the map keyed by the FeedItem id instead of the seq:

```ts
    const turnIdByItemId = new Map<string, string>();
    for (const e of tail) {
      turnIdByItemId.set(String(e.seq), e.turnId);
      if (e.replyId !== null) turnIdByItemId.set(e.replyId, e.turnId);
    }
```
and use `turnIdByItemId.get(item.id)`. Delete `replyIdBySeq` — the item carries its own `replyId` now.

- [ ] **Step 3: Supply `currentReplyId` from the runtime**

In `gateway/src/runtime/session-runtime.ts`, where `createConversationFeed({...})` is constructed, add:

```ts
    currentReplyId: () => inFlight?.replyId ?? null,
```

- [ ] **Step 4: Run the repro test**

```bash
source scripts/env.sh && cd gateway/src && bun test runtime/reply-bubble-convergence.test.ts
```
Expected: BOTH cases PASS. `live`, `committed` and `replay` are all a single-element array holding the same string.

- [ ] **Step 5: Fix the projection tests that assumed one item per entry**

```bash
source scripts/env.sh && cd gateway/src && bun test store/ runtime/
```
`client-projection.test.ts` and `projection-convergence.test.ts` will have cases asserting an item per assistant entry. Update the expectations to the folded shape. Do NOT weaken `projection-convergence.test.ts`'s tail-vs-full-replay assertion — if a tail projects a different id than a full replay, `firstSeqOf` is wrong and must be fixed, not the test.

- [ ] **Step 6: Commit**

```bash
source scripts/env.sh && cd gateway/src && bun test && cd ../.. && bun run typecheck
git add -A && git commit -m "fix(projection): fold one reply into one item, so committed matches what streamed"
```

---

# Slice B — Server-authoritative task list

---

### Task 4: The `tasklist.state` frame

**Files:**
- Modify: `shared/protocol/src/messages.ts`
- Modify: `gateway/src/session-handlers/frame-lanes.ts`
- Test: `gateway/src/session-handlers/frame-lanes.test.ts` (totality test covers it automatically)

**Interfaces:**
- Produces: `taskListItemSchema`, `taskListStateSchema`, types `TaskListItem`, `TaskListStateMessage`; `"tasklist.state"` is a session-lane frame.

- [ ] **Step 1: Add the schemas**

In `shared/protocol/src/messages.ts`, directly after `turnToolUpdateSchema` and its type export:

```ts
// ─── Task list (the composer strip) ───
//
// FULL STATE, NOT DELTAS. The replay journal is a byte-capped evicting ring
// (session-handlers/frame-journal.ts): a client behind the window gets a real
// gap and a fresh answer, so an add/update/remove op-stream would need a
// snapshot frame AND a client-side reconciliation of ops against it — the
// exact re-derivation this design removes everywhere else. The list is a
// handful of rows per turn, so the whole thing rides every time: idempotent,
// last-one-wins, replay-safe, and a late joiner needs nothing special.
//
// The gateway owns the LIFETIME too (runtime/task-list.ts): a foreground call
// dies with its turn, a background `delegateTask` outlives it. No client ever
// reasons about when a row should disappear.

export const taskListKindSchema = z.enum(["foreground", "background"]);
export type TaskListKind = z.infer<typeof taskListKindSchema>;

export const taskListItemSchema = z.object({
  /** Stable row identity: the provider's `toolCallId` for a foreground call,
   *  the gateway's `taskId` for a background one. Clients key on it and never
   *  mint one. */
  id: z.string(),
  toolName: z.string(),
  kind: taskListKindSchema,
  status: turnToolStatusSchema,
  /** Already-truncated preview of the call's arguments. Rendered verbatim;
   *  never logged by a client (it is user content). */
  argsPreview: z.string(),
  startedAtMs: z.number().int().nonnegative(),
  /** Present once the row reaches a terminal status. */
  endedAtMs: z.number().int().nonnegative().optional(),
});
export type TaskListItem = z.infer<typeof taskListItemSchema>;

export const taskListStateSchema = z.object({
  type: z.literal("tasklist.state"),
  /** The turn this list belongs to, or null when only background rows survive
   *  a finished turn. Clients label with it; they never infer it. */
  turnId: z.string().nullable(),
  items: z.array(taskListItemSchema),
});
export type TaskListStateMessage = z.infer<typeof taskListStateSchema>;
```

Add `taskListStateSchema` to the `gatewayMessageSchema` discriminated union alongside the other `turn.*` members.

- [ ] **Step 2: Assign the lane**

In `gateway/src/session-handlers/frame-lanes.ts`, in the `// ─── session lane ───` block, after `"turn.tool.update": "session",`:

```ts
  // The composer's task strip. SESSION lane: it is conversation state every
  // attached window must agree on, and — unlike `conversation.snapshot` — the
  // full-state payload is IDENTICAL for every window, so re-emitting it at
  // attach cannot clobber a peer's view. That is why it needs no
  // connection-lane twin.
  "tasklist.state": "session",
```

- [ ] **Step 3: Run the lane totality test**

```bash
source scripts/env.sh && cd gateway/src && bun test session-handlers/frame-lanes.test.ts
```
Expected: PASS. It reads the union back out of zod, so a missing lane assignment would have thrown.

- [ ] **Step 4: Commit**

```bash
source scripts/env.sh && bun run typecheck
git add -A && git commit -m "feat(protocol): add tasklist.state, one idempotent full-state frame"
```

---

### Task 5: `TaskListProjector`

Pure, per-session, no I/O. Owns both the rows and their lifetime.

**Files:**
- Create: `gateway/src/runtime/task-list.ts`
- Create: `gateway/src/runtime/task-list.test.ts`

**Interfaces:**
- Consumes: `TaskListItem` (Task 4), `ToolUpdate` from `gateway/src/runtime/react-loop.ts:70`, `DelegationProgress` from `gateway/src/runtime/turn-emitter.ts:41`.
- Produces:

```ts
export interface TaskListProjector {
  items(): TaskListItem[];
  turnId(): string | null;
  onTurnStarted(turnId: string): boolean;
  onToolUpdate(turnId: string, update: ToolUpdate): boolean;
  onDelegationProgress(progress: DelegationProgress): boolean;
  onTurnEnded(turnId: string): boolean;
}
export function createTaskListProjector(deps: { now: () => number }): TaskListProjector;
```
Every mutator returns `true` when the published state changed, so the caller emits exactly once per real change.

- [ ] **Step 1: Write the failing test**

Create `gateway/src/runtime/task-list.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createTaskListProjector } from "./task-list.js";

function fixedClock(): { now: () => number; tick: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

describe("TaskListProjector", () => {
  it("adds a foreground row on its running update and stamps the start", () => {
    const clock = fixedClock();
    const p = createTaskListProjector({ now: clock.now });
    p.onTurnStarted("t1");
    expect(p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" })).toBe(true);
    expect(p.items()).toEqual([
      { id: "c1", toolName: "ma_search", kind: "foreground", status: "running", argsPreview: "{}", startedAtMs: 1_000 },
    ]);
    expect(p.turnId()).toBe("t1");
  });

  it("transitions a row in place and stamps the end", () => {
    const clock = fixedClock();
    const p = createTaskListProjector({ now: clock.now });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    clock.tick(250);
    expect(p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" })).toBe(true);
    expect(p.items()).toHaveLength(1);
    expect(p.items()[0]?.status).toBe("done");
    expect(p.items()[0]?.startedAtMs).toBe(1_000);
    expect(p.items()[0]?.endedAtMs).toBe(1_250);
  });

  it("keys a background dispatch on its taskId, not its toolCallId", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c9", toolName: "delegateTask", status: "running", argsPreview: "{}", taskId: "task-7" });
    expect(p.items()[0]?.id).toBe("task-7");
    expect(p.items()[0]?.kind).toBe("background");
  });

  it("drops foreground rows at the turn boundary and keeps background ones", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" });
    p.onToolUpdate("t1", { toolCallId: "c2", toolName: "delegateTask", status: "running", argsPreview: "{}", taskId: "task-7" });
    expect(p.onTurnEnded("t1")).toBe(true);
    expect(p.items().map((i) => i.id)).toEqual(["task-7"]);
    // No turn owns the list any more — only a background row survives it.
    expect(p.turnId()).toBeNull();
  });

  it("removes a background row when its delegation reports terminal", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c2", toolName: "delegateTask", status: "running", argsPreview: "{}", taskId: "task-7" });
    p.onTurnEnded("t1");
    expect(p.onDelegationProgress({ taskId: "task-7", turnId: "t1", agent: "hermes", status: "done" })).toBe(true);
    expect(p.items()).toEqual([]);
  });

  it("ignores a turn boundary for a turn it does not own", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    expect(p.onTurnEnded("t-other")).toBe(false);
    expect(p.items()).toHaveLength(1);
  });

  it("clears the previous turn's rows when a new turn starts", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" });
    expect(p.onTurnStarted("t2")).toBe(true);
    expect(p.items()).toEqual([]);
    expect(p.turnId()).toBe("t2");
  });

  it("reports no change when an identical update repeats", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    expect(p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
source scripts/env.sh && cd gateway/src && bun test runtime/task-list.test.ts
```
Expected: FAIL — `Cannot find module './task-list.js'`.

- [ ] **Step 3: Implement**

Create `gateway/src/runtime/task-list.ts`:

```ts
// TaskListProjector — the live tool/task list the composer strip renders, and
// the authority on how long each row lives.
//
// WHY THE GATEWAY OWNS THE LIFETIME. Tool activity used to render as pills
// attached to a chat bubble, which forced every client to answer "which bubble
// does this pill belong to" — a question with no stable answer once a mid-turn
// steer can split a reply. The strip has no anchor, so the only remaining
// question is when a row disappears, and that is a fact only the gateway holds:
//
//   foreground — awaited by the ReAct loop, so anything still running when the
//                turn ends is an orphan. Dies with the turn.
//   background — a `delegateTask` dispatch. It outlives the turn that spawned
//                it in every case and nothing cancels it (tools/delegate-task.ts),
//                so it survives the boundary and leaves on its own terminal
//                `delegation.progress`.
//
// Pure: no I/O, no wall clock of its own. The caller emits `tasklist.state`
// whenever a mutator returns true.

import type { TaskListItem } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ToolUpdate } from "./react-loop.js";
import type { DelegationProgress } from "./turn-emitter.js";

const log = getLog(["sentient", "runtime", "task-list"]);

const STATUS_RUNNING = "running";

export interface TaskListProjector {
  /** The rows to publish, oldest first. */
  items(): TaskListItem[];
  /** The turn the list belongs to, or null when only background rows remain. */
  turnId(): string | null;
  onTurnStarted(turnId: string): boolean;
  onToolUpdate(turnId: string, update: ToolUpdate): boolean;
  onDelegationProgress(progress: DelegationProgress): boolean;
  onTurnEnded(turnId: string): boolean;
}

export interface TaskListProjectorDeps {
  /** Injected so the projector stays pure and its lifetime rules are testable
   *  without a real clock. */
  readonly now: () => number;
}

export function createTaskListProjector(deps: TaskListProjectorDeps): TaskListProjector {
  // Insertion-ordered: the strip renders dispatch order, which is the order the
  // loop actually called the tools in.
  const rows = new Map<string, TaskListItem>();
  let currentTurnId: string | null = null;

  function snapshot(): TaskListItem[] {
    return [...rows.values()];
  }

  function sameRow(a: TaskListItem | undefined, b: TaskListItem): boolean {
    if (a === undefined) return false;
    return (
      a.status === b.status &&
      a.toolName === b.toolName &&
      a.kind === b.kind &&
      a.argsPreview === b.argsPreview &&
      a.endedAtMs === b.endedAtMs
    );
  }

  return {
    items: snapshot,
    turnId: () => currentTurnId,

    onTurnStarted(turnId: string): boolean {
      // A new turn's strip starts empty of FOREGROUND work. Background rows
      // from an earlier turn are still running and stay.
      let changed = currentTurnId !== turnId;
      for (const [id, row] of rows) {
        if (row.kind === "foreground") {
          rows.delete(id);
          changed = true;
        }
      }
      currentTurnId = turnId;
      if (changed) log.debug("task-list.turn-started", { turnId, rows: rows.size });
      return changed;
    },

    onToolUpdate(turnId: string, update: ToolUpdate): boolean {
      const isBackground = update.taskId !== undefined;
      const id = update.taskId ?? update.toolCallId;
      const existing = rows.get(id);
      const isTerminal = update.status !== STATUS_RUNNING;
      const next: TaskListItem = {
        id,
        toolName: update.toolName,
        kind: isBackground ? "background" : "foreground",
        status: update.status,
        argsPreview: update.argsPreview ?? "",
        startedAtMs: existing?.startedAtMs ?? deps.now(),
        ...(isTerminal ? { endedAtMs: deps.now() } : {}),
      };
      if (sameRow(existing, next)) return false;
      rows.set(id, next);
      currentTurnId = turnId;
      // argsPreview is user content and is never logged (logging rules).
      log.debug("task-list.tool-update", { turnId, id, kind: next.kind, status: next.status, rows: rows.size });
      return true;
    },

    onDelegationProgress(progress: DelegationProgress): boolean {
      const existing = rows.get(progress.taskId);
      if (existing === undefined) return false;
      if (progress.status === STATUS_RUNNING) {
        if (existing.status === STATUS_RUNNING) return false;
        rows.set(progress.taskId, { ...existing, status: progress.status });
        return true;
      }
      // Terminal: the delegation is over, so the row leaves the strip. Its
      // RESULT arrives separately as a stimulus that starts its own turn — the
      // strip is live state, never a record.
      rows.delete(progress.taskId);
      log.debug("task-list.delegation-settled", {
        taskId: progress.taskId,
        status: progress.status,
        rows: rows.size,
      });
      return true;
    },

    onTurnEnded(turnId: string): boolean {
      if (currentTurnId !== turnId) return false;
      for (const [id, row] of rows) {
        if (row.kind === "foreground") rows.delete(id);
      }
      currentTurnId = null;
      log.debug("task-list.turn-ended", { turnId, rows: rows.size });
      // Always a change: `turnId` is part of the published frame and it just
      // went null, even in the case where no row was dropped.
      return true;
    },
  };
}
```

- [ ] **Step 4: Run the test**

```bash
source scripts/env.sh && cd gateway/src && bun test runtime/task-list.test.ts
```
Expected: all 8 cases PASS.

- [ ] **Step 5: Commit**

```bash
source scripts/env.sh && bun run typecheck
git add -A && git commit -m "feat(runtime): add the task-list projector that owns row lifetime"
```

---

### Task 6: Publish `tasklist.state` from the session runtime

Dual-emit: `turn.tool.update` keeps flowing so every client stays green until Slices C–E migrate. It is retired in Task 15.

**Files:**
- Modify: `gateway/src/runtime/turn-emitter.ts` (add `taskList`)
- Modify: `gateway/src/session-handlers/ws-turn-emitter.ts` (implement it)
- Modify: `gateway/src/runtime/session-runtime.ts` (own the projector, drive it, publish on attach)
- Test: `gateway/src/runtime/session-runtime.test.ts` (extend `recordingEmitter`), new cases below

**Interfaces:**
- Consumes: `createTaskListProjector` (Task 5), `taskListStateSchema` (Task 4).
- Produces: `TurnEmitter.taskList(turnId: string | null, items: TaskListItem[]): void`; `SessionRuntime.emitTaskList(): void`.

- [ ] **Step 1: Add the emitter method**

`gateway/src/runtime/turn-emitter.ts` — add to the `TurnEmitter` interface:

```ts
  /**
   * The session's whole live task list (runtime/task-list.ts) — every row, every
   * time. FULL STATE by design: last-one-wins makes replay, fan-out and a late
   * joiner all the same operation, and leaves the client with nothing to
   * reconcile. `turnId` is null when only background rows outlive their turn.
   */
  taskList(turnId: string | null, items: TaskListItem[]): void;
```
and to `createLoggingTurnEmitter`:

```ts
    taskList(turnId, items) {
      // Row COUNT and statuses only — `argsPreview` is user content.
      log.debug("turn-emitter.task-list", {
        turnId,
        count: items.length,
        statuses: items.map((i) => i.status),
      });
    },
```
Import `TaskListItem` from `@sentient/protocol`.

- [ ] **Step 2: Implement it on the WS emitter**

In `gateway/src/session-handlers/ws-turn-emitter.ts`, beside `toolUpdate`:

```ts
    taskList(turnId: string | null, items: TaskListItem[]) {
      log.debug("turn-emitter.task-list", {
        sessionId,
        turnId,
        count: items.length,
      });
      emit({ type: "tasklist.state", turnId, items });
    },
```

- [ ] **Step 3: Drive the projector from the runtime**

In `gateway/src/runtime/session-runtime.ts`:

Construct it beside the other per-session collaborators:

```ts
  const taskList = createTaskListProjector({ now: () => Date.now() });

  /** Publish the strip. Called whenever the projector reports a real change,
   *  and once per attach so a window that joins mid-turn sees the live rows
   *  without a frame type of its own. */
  function publishTaskList(): void {
    emitter.taskList(taskList.turnId(), taskList.items());
  }
```

In `startTurn`, right after `emitter.turnStarted(turnId, trigger)`:

```ts
    if (taskList.onTurnStarted(turnId)) publishTaskList();
```

In the `onToolUpdate` callback passed to `ReactLoopDeps`, after `emitter.toolUpdate(id, u)`:

```ts
        if (taskList.onToolUpdate(id, u)) publishTaskList();
```

Where the turn settles (the `onTurnSettled` continuation, beside `feed.publishAll()`):

```ts
      if (taskList.onTurnEnded(turnId)) publishTaskList();
```

Where `delegationProgress` is surfaced (the broker's background-completion sink), before forwarding to the emitter:

```ts
      if (taskList.onDelegationProgress(progress)) publishTaskList();
```

Add to the `SessionRuntime` interface and its implementation, beside `emitConversationSnapshot`:

```ts
  /** Publish the live task list to the attaching window. Called once per
   *  `session.configure`, alongside `emitConversationSnapshot`. The frame is
   *  full state and identical for every window, so re-emitting it on the
   *  session lane cannot clobber a peer's view — which is why the strip needs
   *  no connection-lane twin of its own. A no-op after `dispose()`. */
  emitTaskList(): void;
```
implemented as `emitTaskList: whenLive("emitTaskList", publishTaskList),`.

Call it from `gateway/src/session-handlers/ws-session-configure.ts` immediately after the existing `emitConversationSnapshot()` call.

- [ ] **Step 4: Write the failing runtime test**

Append to `gateway/src/runtime/session-runtime.test.ts`. First extend `RecordedEvent["type"]` with `"taskList"` and add to `recordingEmitter`:

```ts
    taskList: (turnId, items) => events.push({ type: "taskList", turnId: turnId ?? "", items: items as never }),
```

Then the case:

```ts
describe("SessionRuntime — task list", () => {
  it("publishes the strip on dispatch and clears foreground rows at the turn boundary", async () => {
    const am = createAccessManager({ userDataRoot: `${ROOT}/tasklist` });
    const alice = createUserPrincipal("u_aaaaaaaa", "adult", "home");
    mkdirSync(am.userHomeDir(alice), { recursive: true });

    const provider = fakeProvider(async function* (callIndex) {
      if (callIndex === 1) {
        yield {
          type: "tool_call",
          toolCall: { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", content: "sunny out" };
      yield { type: "done", finishReason: "stop" };
    });
    const broker = fakeBroker([weatherDef], async () => ({ content: "sunny", isError: false }));
    const emitter = recordingEmitter();
    const runtime = createSessionRuntime({
      principal: alice,
      sessionId: "sess-tasklist",
      accessManager: am,
      provider,
      broker,
      emitter,
      timeZone: { zone: () => "UTC" },
      systemPrompt: "you are a test assistant",
      config: testConfig(),
    });

    runtime.submit({ kind: "conversational", text: "weather?" });
    await waitUntilIdle(runtime);

    const lists = emitter.events.filter((e) => e.type === "taskList");
    expect(lists.length).toBeGreaterThan(1);
    // Mid-turn the strip carried the running call…
    expect(lists.some((e) => (e.items ?? []).length === 1)).toBe(true);
    // …and the last publish, at the turn boundary, is empty: a foreground call
    // is awaited by the loop, so none of it outlives the turn.
    expect(lists[lists.length - 1]?.items ?? []).toEqual([]);
    runtime.dispose();
  });
});
```

- [ ] **Step 5: Run it**

```bash
source scripts/env.sh && cd gateway/src && bun test runtime/session-runtime.test.ts
```
Expected: FAIL first (no `taskList` events), PASS after Step 3 is in place.

- [ ] **Step 6: Run the whole gateway suite and commit**

```bash
source scripts/env.sh && cd gateway/src && bun test && cd ../.. && bun run typecheck
git add -A && git commit -m "feat(runtime): publish the task list as server-owned full state"
```

---

# Slice C — Web

---

### Task 7: web-sdk — `TaskListConnector` and the `replyId` rename

**Files:**
- Create: `shared/web-sdk/src/connectors/task-list-connector.ts`
- Create: `shared/web-sdk/src/connectors/task-list-connector.test.ts`
- Modify: `shared/web-sdk/src/connectors/inflight-message-connector.ts:11`, `:57-58`, `:69`, `:80`, `:91-93`, `:104`, `:112`
- Modify: `shared/web-sdk/src/connectors/conversation-history-connector.ts:18-24`, `:124`, `:131`
- Modify: `shared/web-sdk/src/index.ts` (export the new connector and its item type)

**Interfaces:**
- Consumes: `tasklist.state` (Task 4); `turn.text.delta.replyId`, `conversation.entry.replyId` (Task 1); assistant item `replyId` (Task 2).
- Produces: `TaskListConnector` with `capability = "tasklist"`, `list(): readonly TaskListItem[]`, `turnId(): string | null`, config `{ onUpdate?(turnId: string | null, items: readonly TaskListItem[]): void }`; `InFlightMessage.replyId?: string`; `CommittedFeedItem` gains `replyId?: string`.

- [ ] **Step 1: Write the failing connector test**

Create `shared/web-sdk/src/connectors/task-list-connector.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { TaskListConnector } from "./task-list-connector.js";

function fakeSdk() {
  const handlers = new Map<string, (m: unknown) => void>();
  return {
    on(type: string, fn: (m: unknown) => void) {
      handlers.set(type, fn);
      return () => handlers.delete(type);
    },
    send(type: string, payload: Record<string, unknown>) {
      handlers.get(type)?.({ type, ...payload });
    },
  };
}

describe("TaskListConnector", () => {
  it("declares the tasklist capability", () => {
    expect(new TaskListConnector().capability).toBe("tasklist");
  });

  it("replaces the whole list on every frame", () => {
    const onUpdate = vi.fn();
    const c = new TaskListConnector({ onUpdate });
    const sdk = fakeSdk();
    c.attach(sdk as never);

    sdk.send("tasklist.state", {
      turnId: "t1",
      items: [{ id: "a", toolName: "x", kind: "foreground", status: "running", argsPreview: "{}", startedAtMs: 1 }],
    });
    expect(c.list()).toHaveLength(1);
    expect(c.turnId()).toBe("t1");

    sdk.send("tasklist.state", { turnId: null, items: [] });
    expect(c.list()).toEqual([]);
    expect(c.turnId()).toBeNull();
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
source scripts/env.sh && cd shared/web-sdk && bun run test -- task-list-connector
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the connector**

Create `shared/web-sdk/src/connectors/task-list-connector.ts`:

```ts
// TaskListConnector — the composer task strip's mirror.
//
// Holds whatever the last `tasklist.state` frame said and nothing else. The
// gateway sends FULL STATE every time (runtime/task-list.ts owns which rows
// exist and how long each lives), so there is no merge, no dedupe, and no
// lifetime rule on this side. Replacing the whole list is the entire contract:
// a replayed frame, a fan-out to a second window and a late joiner's attach are
// the same operation.
//
// Replaces the retired ToolStatusConnector, which held tool calls forever and
// left every consumer deriving which bubble a pill belonged to.

import type { TaskListItem, TaskListStateMessage } from "@sentient/protocol";
import { createLogger } from "../logging.js";
import type { Connector, ConnectorKind, SdkHandle } from "./types.js";

const log = createLogger(["sentient", "web-sdk", "task-list"]);

export interface TaskListConnectorConfig {
  onUpdate?: (turnId: string | null, items: readonly TaskListItem[]) => void;
}

export class TaskListConnector implements Connector {
  readonly capability = CAPABILITY;
  readonly kind: ConnectorKind = "status";

  private items: readonly TaskListItem[] = [];
  private turn: string | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly config: TaskListConnectorConfig = {}) {}

  list(): readonly TaskListItem[] {
    return this.items;
  }

  turnId(): string | null {
    return this.turn;
  }

  attach(sdk: SdkHandle): void {
    this.unsubscribe = sdk.on("tasklist.state", (raw) => {
      const m = raw as TaskListStateMessage;
      this.items = m.items;
      this.turn = m.turnId;
      // Row COUNT only — argsPreview is user content and never logged.
      log.debug("tasklist.state", { turnId: m.turnId, count: m.items.length });
      this.config.onUpdate?.(this.turn, this.items);
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Drop everything. Called on disconnect, same as every other mirror. */
  reset(): void {
    this.items = [];
    this.turn = null;
    this.config.onUpdate?.(null, this.items);
  }
}

const CAPABILITY = "tasklist";
```

Match the exact `Connector` / `SdkHandle` / `createLogger` import paths used by the sibling `tool-status-connector.ts` — copy them verbatim from that file rather than guessing.

- [ ] **Step 4: Rename `messageId` → `replyId` in the two feed connectors**

`inflight-message-connector.ts`: `InFlightMessage.messageId?` → `replyId?`; the buffer value type field; `list()`'s conditional spread; `const key = m.replyId ?? m.turnId` (L93); the re-key adoption block; the delta append. Reword the comments to say "reply" instead of "bubble key"/"message".

`conversation-history-connector.ts`: `CommittedFeedItem`'s `messageId?` → `replyId?`; the frame read at L124 and the re-attach at L131. Note the item now carries `replyId` itself — keep the frame value as the override so both paths agree:

```ts
      const entry = { ...m.item, ...(m.turnId ? { turnId: m.turnId } : {}), ...(m.replyId ? { replyId: m.replyId } : {}) };
```

- [ ] **Step 5: Export and run**

Add `TaskListConnector`, `TaskListConnectorConfig` to `shared/web-sdk/src/index.ts` beside the other connector exports.

```bash
source scripts/env.sh && cd shared/web-sdk && bun run test && cd ../.. && bun run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web-sdk): mirror the server task list, rename the bubble key to replyId"
```

---

### Task 8: webui — the composer task strip

**Files:**
- Create: `gateway/webui/src/components/dock/composer-task-strip.tsx`
- Modify: `gateway/webui/src/components/dock/composer.tsx:12-34` (props), `:126-131` (render slot)
- Modify: `gateway/webui/src/app.tsx:307-359` (pass the list)
- Modify: `gateway/webui/src/hooks/use-voice-client.ts:110`, `:157`, `:236-251`, `:531-543`
- Modify: `gateway/webui/src/hooks/cycle-helpers.ts` (delete tile plumbing + the merge branch)
- Modify: `gateway/webui/src/types.ts:22`, `:28`
- Modify: `gateway/webui/src/components/chat/message-bubble.tsx:30`, `:31`, `:65-72`
- Delete: `gateway/webui/src/components/chat/tool-pill-strip.tsx` (moves to the dock)
- Modify: `gateway/webui/src/components/chat/tool-inline-detail.tsx` (import path only)
- Modify: `gateway/webui/src/styles/components.css`
- Test: `gateway/webui/src/hooks/cycle-helpers.test.ts`

**Interfaces:**
- Consumes: `TaskListConnector` (Task 7), `TaskListItem` (Task 4).
- Produces: `ComposerTaskStrip` with props `{ items: readonly TaskListItem[] }`; `ComposerProps` gains `tasks: readonly TaskListItem[]`; `ChatMessage` loses `tools` and renames `messageId` → `replyId`.

- [ ] **Step 1: Move the strip into the dock**

`git mv gateway/webui/src/components/chat/tool-pill-strip.tsx gateway/webui/src/components/dock/composer-task-strip.tsx`, then rewrite its head so it takes the server list and owns its own open state:

```tsx
// ComposerTaskStrip — the live tool/task rows, flush with the top edge of the
// composer, inside its border (design v2, `sentient-webui-design-v2/screenshots/
// 00-chat-reference.png`; spec `docs/superpowers/specs/2026-04-18-cerebrum-ux-refresh-design.md`
// §4.9).
//
// It replaced pills attached to a chat bubble. Those forced every client to
// answer "which bubble does this pill belong to", which has no stable answer
// once a mid-turn steer can split a reply. The strip has no anchor: the gateway
// says which rows exist and when they leave (`tasklist.state`), and this
// renders them.

import type { TaskListItem } from "@sentient/protocol";
import { useState } from "preact/hooks";
import { ToolInlineDetail } from "../chat/tool-inline-detail.js";
import { Icon } from "../common/icon.js";

export interface ComposerTaskStripProps {
  items: readonly TaskListItem[];
}
```

Keep `statusClass`, `shortToolName`, `iconForTool` and the pill markup as-is, but read `TaskListItem` fields (`id`, `toolName`, `status`, `argsPreview`) instead of `ToolCallSnapshotItem`, key on `item.id`, hold `openId` in local state, and render `ToolInlineDetail` ABOVE the pills (the strip sits at the top of the composer, so detail expands upward). Return `null` when `items.length === 0`.

`ToolInlineDetail` currently reads `task.argsPreview` / `task.resultPreview`; change its prop type to `{ item: TaskListItem; direction: "down" | "up" }` and drop the `resultPreview` branch — a `tasklist.state` row has no result (results are the model's to narrate).

- [ ] **Step 2: Render it in the composer**

`composer.tsx` — add to `ComposerProps`:

```tsx
  /** The gateway's live task list. Server-owned: the strip renders it, it never
   *  derives which rows exist or when they leave. */
  tasks: readonly TaskListItem[];
```
and inside the composer card, immediately above the `connection-pill` block (so it is the topmost element inside the border):

```tsx
        <ComposerTaskStrip items={tasks} />
```

`app.tsx` — pass `tasks={client.tasks.value}` to `<Composer .../>` (the signal already exists at `app.tsx:177`).

- [ ] **Step 3: Swap the connector in the hook**

`use-voice-client.ts` — replace the `ToolStatusConnector` construction (L531-543) with:

```ts
    new TaskListConnector({
      onUpdate: (_turnId, items) => {
        tasks.value = items;
        refreshStatus();
      },
    }),
```
Change the `tasks` signal's type (L110) to `useSignal<readonly TaskListItem[]>([])`. Delete `rawTasksRef` (L157) and every read of it. In `refreshStatus`, count with `tasks.value.filter((t) => t.status === "running").length`. In `refreshMessages` (L236-251), drop the `attachToolsToAssistantMessages` call — `messages.value = base`.

Note: `currentTurnId` was being derived from the latest tool's `turnId` (L538-539); take it from the connector's `turnId()` instead, or drop that derivation if the streaming path already sets it — verify by reading the surrounding code before editing.

- [ ] **Step 4: Delete the tile plumbing from `cycle-helpers.ts`**

Delete: `COMMITTED_TOOL_STATUS`, `NO_TURN_ID`, `RESULT_PREVIEW_LEN`, `toCommittedTile`, `countByTurnId`, `mergeTiles`, `reportedTruncations`, `MAX_REPORTED_TRUNCATIONS`, `reportTruncatedLiveList`, `uncommittedLiveTiles`, `findOrphanTarget`, `anchorIndexByTurnId`, `forwardOrphans`, `attachToolsToAssistantMessages`, `anchorPendingTools`, and `FeedWalk.pendingTools` (the interface becomes `{ readonly out: ChatMessage[] }`). Delete the `kind === "tool"` branch in `appendCommittedItems` and the `pendingTools` reset in the `user` branch. Delete the whole L60-108 positional-join comment block.

**Delete the merge branch (L413-426) too** — the gateway now sends one item per reply, so a client-side merge can only disagree with it.

Rename `msg.messageId` → `msg.replyId` in `buildAssistantMessage` (L342).

- [ ] **Step 5: Strip the bubble**

`types.ts` — `ChatMessage`: rename `messageId?` → `replyId?`, delete the `tools?` field and the `ToolCallSnapshotItem` import.

`message-bubble.tsx` — delete `openToolCallId` state, `handleToggle`, the `tools` destructure and the `ToolPillStrip` render block (L65-72), and the import.

`styles/components.css` — move `.tool-strip*`, `.tool-pill*` and `.tool-inline-detail*` rules next to the `.composer` rules and restyle the strip to sit flush inside the composer's top edge: full width, `border-bottom` hairline instead of `::before`, no negative offsets. Add the missing status-dot rules the audit found dead — `--done` and `--error` (the wire vocabulary is `running | done | error`; the old `--finished`/`--failed`/`--cancelled` rules matched nothing).

- [ ] **Step 6: Fix the tests**

`cycle-helpers.test.ts` — the "committed tool tiles" describe (L61-230) is entirely about the deleted plumbing. Delete it. Keep the "background completions" describe (L232). Add one case pinning the new contract:

```ts
it("renders one bubble per assistant item, because the gateway already folded the reply", () => {
  const items = [
    { entryId: "r1", ts: 1, kind: "assistant", replyId: "r1", content: "one reply, already whole" },
  ] as const;
  const out = deriveMessages(items as never, []);
  expect(out).toHaveLength(1);
  expect(out[0]?.text).toBe("one reply, already whole");
});
```

- [ ] **Step 7: Run and commit**

```bash
source scripts/env.sh && bun run test && bun run typecheck && bun run lint
git add -A && git commit -m "feat(webui): move tool rows to the composer strip, off the chat bubble"
```

---

# Slice D — Mobile shared

---

### Task 9: mobile-sdk protocol + connectors

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/TaskListConnector.kt`
- Create: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/TaskListConnectorTest.kt`
- Modify: `.../protocol/ServerMessage.kt:86-97` (`TurnTextDelta`), `:191-204` (`ConversationEntry`), + a new `TaskListState` member
- Modify: `.../protocol/ConversationFeedItem.kt:74-86` (`Assistant`)
- Modify: `.../protocol/SdkEvent.kt:10-11`
- Modify: `.../connectors/InFlightMessageConnector.kt` (rename throughout)
- Modify: `.../connectors/ConversationHistoryConnector.kt:180-191`, `:206`
- Modify: `.../sdk/SdkConnectors.kt:148` (swap `tasks` wiring)
- Delete: `.../connectors/TaskStatusConnector.kt` and `.../commonTest/.../TaskStatusConnectorTest.kt`, `TaskEventsTest.kt`

**Interfaces:**
- Consumes: `tasklist.state` (Task 4), `replyId` on wire (Tasks 1–2).
- Produces:

```kotlin
@Serializable data class TaskListItem(
    val id: String,
    val toolName: String = "",
    val kind: String = "foreground",
    val status: String = "",
    val argsPreview: String = "",
    val startedAtMs: Long = 0L,
    val endedAtMs: Long? = null,
)
class TaskListConnector(
    private val onUpdate: ((turnId: String?, items: List<TaskListItem>) -> Unit)? = null,
) : Connector { fun list(): List<TaskListItem>; fun turnId(): String? }
// CAPABILITY = "tasklist"
```
`InFlightMessage.replyId`, `SdkEvent.MessageStarted(turnId, replyId)`, `SdkEvent.MessageDelta(turnId, chunk, replyId)`, `ConversationFeedItem.Assistant.replyId`.

- [ ] **Step 1: Add the wire members**

`ServerMessage.kt` — rename both `messageId` fields to `replyId`, and add:

```kotlin
    /**
     * The live task/tool rows the composer strip renders. FULL STATE every
     * time — the gateway owns which rows exist and how long each lives
     * (foreground dies with its turn, a background delegateTask outlives it),
     * so this client replaces its list and derives nothing.
     */
    @Serializable
    @SerialName("tasklist.state")
    data class TaskListState(
        val turnId: String? = null,
        val items: List<TaskListItem> = emptyList(),
    ) : ServerMessage()
```

Put `TaskListItem` in its own file `.../protocol/TaskListItem.kt` with the shape above, every field defaulted so a partial frame degrades rather than failing to decode (matching `ConversationFeedItem`'s precedent).

`ConversationFeedItem.kt` — `Assistant.messageId` → `replyId`; update its doc comment to say the field now arrives ON THE WIRE (the gateway sends it on the item as of Task 2) and the frame value is only an override.

`SdkEvent.kt` — rename `messageId` → `replyId` on `MessageStarted` and `MessageDelta`.

- [ ] **Step 2: Write the failing connector test**

Create `.../commonTest/kotlin/io/sentient/mobilesdk/connectors/TaskListConnectorTest.kt`:

```kotlin
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.TaskListItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TaskListConnectorTest {
    @Test
    fun declares_the_tasklist_capability() {
        assertEquals("tasklist", TaskListConnector().capability)
    }

    @Test
    fun replaces_the_whole_list_on_every_frame() {
        val seen = mutableListOf<Pair<String?, List<TaskListItem>>>()
        val c = TaskListConnector(onUpdate = { turnId, items -> seen += turnId to items })

        c.handle(
            ServerMessage.TaskListState(
                turnId = "t1",
                items = listOf(TaskListItem(id = "a", toolName = "x", status = "running")),
            ),
        )
        assertEquals(1, c.list().size)
        assertEquals("t1", c.turnId())

        c.handle(ServerMessage.TaskListState(turnId = null, items = emptyList()))
        assertEquals(0, c.list().size)
        assertNull(c.turnId())
        assertEquals(2, seen.size)
    }

    @Test
    fun ignores_frames_it_does_not_own() {
        val c = TaskListConnector()
        c.handle(ServerMessage.TurnCompleted(turnId = "t1"))
        assertEquals(0, c.list().size)
    }
}
```

- [ ] **Step 3: Run it and watch it fail**

```bash
source scripts/env.sh && ./gradlew :shared:mobile-sdk:allTests --tests '*TaskListConnectorTest*'
```
Expected: FAIL — unresolved reference `TaskListConnector`.

- [ ] **Step 4: Implement the connector**

Create `.../connectors/TaskListConnector.kt`:

```kotlin
// ---------------------------------------------------------------------------
// TaskListConnector — the composer task strip's mirror.
//
// Holds the last `tasklist.state` and nothing else. The gateway sends FULL
// STATE every time and owns row lifetime (a foreground call dies with its
// turn; a background delegateTask outlives it), so there is no upsert, no
// dedup and no clearing rule on this side. Replacing the list IS the contract:
// a replayed frame, a fan-out to a second window and a late joiner's attach are
// all the same operation.
//
// Replaces TaskStatusConnector, which kept tool rows forever (its `clear()` had
// no production caller) and left the UI deriving which bubble a pill belonged
// to — a question with no stable answer once a mid-turn steer splits a reply.
//
// Threading: single-threaded; the orchestrator routes frames on one dispatcher.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.ServerMessage
import io.sentient.mobilesdk.protocol.TaskListItem

class TaskListConnector(
    private val onUpdate: ((turnId: String?, items: List<TaskListItem>) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "task-list")

    private var items: List<TaskListItem> = emptyList()
    private var turn: String? = null

    fun list(): List<TaskListItem> = items

    fun turnId(): String? = turn

    override fun handle(msg: ServerMessage) {
        if (msg !is ServerMessage.TaskListState) return
        items = msg.items
        turn = msg.turnId
        // Row COUNT only — argsPreview is user content (PrivacyGuardTest).
        log.info("state", mapOf("turnId" to (msg.turnId ?: "-"), "count" to msg.items.size))
        onUpdate?.invoke(turn, items)
    }

    companion object {
        const val CAPABILITY: String = "tasklist"
    }
}
```

- [ ] **Step 5: Rename in the two feed connectors and rewire**

`InFlightMessageConnector.kt` — rename `messageId` → `replyId` at L39, L62, L71 (`keyOf`), L84-104, L110, L118, L124-128, L149. Reword comments to "reply".

`ConversationHistoryConnector.kt` — L187-188 becomes:

```kotlin
            if (item is ConversationFeedItem.Assistant && (msg.turnId != null || msg.replyId != null)) {
                item.copy(turnId = msg.turnId ?: item.turnId, replyId = msg.replyId ?: item.replyId)
```
and the log key at L206.

`SdkConnectors.kt` L148 — replace the `TaskStatusConnector` construction with `TaskListConnector(onUpdate = { _, list -> deriver.tasks = list; emit() })`. Change `StateDeriver.tasks`'s type to `List<TaskListItem>`. Delete `TaskStatusConnector.kt` and its two tests.

- [ ] **Step 6: Run and commit**

```bash
source scripts/env.sh && ./gradlew :shared:mobile-sdk:allTests
git add -A && git commit -m "feat(mobile-sdk): mirror the server task list, rename the bubble key to replyId"
```

---

### Task 10: mobile-sdk — drop tile derivation from `StateDeriver`

**Files:**
- Modify: `.../sdk/StateDeriver.kt:100-135` (comment block), `:147-186` (`deriveMessages`), `:188-220` (`committedMessage`), delete `:231-238` (`committedTile`), `:242-288` (`TurnAnchors`, `turnAnchors`, `attachLiveTools`, `mergeTiles`), `:298-302` (`COMMITTED_TOOL_STATUS`)
- Modify: `.../sdk/SdkState.kt:40-54` (`ChatMessage`)
- Test: `.../commonTest/.../sdk/StateDeriverToolsTest.kt` (mostly deleted)

**Interfaces:**
- Consumes: Task 9's types.
- Produces: `ChatMessage` loses `tools`, renames `messageId` → `replyId`; `deriveMessages(feed, inflight, nowMs)` loses its `tasks` parameter.

- [ ] **Step 1: Strip the deriver**

Delete the whole L100-135 positional-join comment block and every symbol listed in **Files** above. `deriveMessages` becomes:

```kotlin
/**
 * Fold committed feed items + the live in-flight buffer into the chat list.
 * User + Assistant entries render as rows; Trigger entries are context for the
 * model, not a user-facing artifact. Empty user / empty-non-cutoff assistant
 * entries are dropped (barge-in markers, pre-token placeholders).
 *
 * TOOL ACTIVITY IS NOT IN THIS LIST. It lives in the composer task strip,
 * driven by `tasklist.state` (TaskListConnector). It used to render as pills
 * anchored to the assistant bubble that followed them, which forced this walk
 * to answer "which bubble owns this tile" — a question with no stable answer
 * once a mid-turn steer splits a reply, and the source of a live/committed
 * disagreement that made a finished reply visibly regroup.
 */
internal fun deriveMessages(
    feed: List<ConversationFeedItem>,
    inflight: InFlightMessage?,
    nowMs: Long,
): List<ChatMessage> {
    val out = ArrayList<ChatMessage>(feed.size + 1)
    for (item in feed) {
        out.add(committedMessage(item) ?: continue)
    }
    if (inflight != null) {
        out.add(
            ChatMessage(
                ts = nowMs,
                role = ROLE_ASSISTANT,
                content = inflight.text,
                streaming = true,
                turnId = inflight.turnId,
                replyId = inflight.replyId,
            ),
        )
    }
    return out
}
```
`committedMessage` keeps its `User`/`Assistant` cases (renaming `messageId` → `replyId`) and returns null for `Tool` and `Trigger`. `deriveTimeline()` becomes `deriveMessages(feed, inflight = null, clock.nowMs())`.

`SdkState.kt` — delete `tools: List<TaskSnapshotItem> = emptyList()`, rename `messageId` → `replyId`.

- [ ] **Step 2: Rewrite the deriver test**

`StateDeriverToolsTest.kt` — every case is about tiles. Rename the file to `StateDeriverTest.kt` and keep only `deriveMessages_propagates_pendingId_on_user_entries` (L174). Add:

```kotlin
    @Test
    fun tool_items_never_render_as_rows() {
        val feed = listOf(
            ConversationFeedItem.User(entryId = "1", ts = 1, channel = "text", content = "hi"),
            ConversationFeedItem.Tool(entryId = "2", ts = 2, toolName = "ma_search", status = "finished", summary = "ok"),
            ConversationFeedItem.Assistant(entryId = "r1", ts = 3, content = "done", replyId = "r1"),
        )
        val out = deriveMessages(feed, inflight = null, nowMs = 10)
        assertEquals(listOf("user", "assistant"), out.map { it.role })
    }
```

- [ ] **Step 3: Run and commit**

```bash
source scripts/env.sh && ./gradlew :shared:mobile-sdk:allTests
git add -A && git commit -m "refactor(mobile-sdk): take tool tiles out of the chat list"
```

---

### Task 11: mobile-data — reply-keyed reveal and a simpler suppression

**Files:**
- Modify: `shared/mobile-data/.../usecase/RevealReducer.kt:41-60`, `:87-151`
- Modify: `shared/mobile-data/.../usecase/ObserveChatUseCase.kt:71-131`
- Modify: `shared/mobile-data/.../model/ChatModel.kt`
- Test: `shared/mobile-data/src/commonTest/.../usecase/RevealReducerTest.kt`, `usecase/ObserveChatUseCaseTest.kt`, `model/ChatModelTest.kt`

**Interfaces:**
- Consumes: Tasks 9–10.
- Produces: `RevealBubble.replyId`, `ChatModel { committed, live, tasks: List<TaskListItem>, pending, historyLoading, reconciledPendingIds }`; `ChatModel.messagesForUi()` no longer injects tasks into the live bubble.

- [ ] **Step 1: Write the failing suppression test**

Add to `ObserveChatUseCaseTest.kt`:

```kotlin
    @Test
    fun a_committed_row_of_another_reply_is_never_suppressed() = runTest {
        // The old predicate fell back to turn-matching whenever EITHER side
        // lacked a key, so a row from the same turn but a different reply
        // vanished behind the live bubble. Keyed on the reply alone, it cannot.
        val repo = FakeConversationRepository()
        val use = ObserveChatUseCase(repo, FakeClock())
        // …drive: MessageStarted(turnId="t1", replyId="r2") then a committed
        // row with turnId="t1", replyId="r1"; assert the r1 row stays visible.
    }
```
Fill the body using the existing fakes and the `runTest` idiom already used in that file (read `committed_twin_suppressed_while_live_same_turn` at L43 and mirror its setup exactly).

- [ ] **Step 2: Run it and watch it fail**

```bash
source scripts/env.sh && ./gradlew :shared:mobile-data:allTests --tests '*ObserveChatUseCaseTest*'
```
Expected: FAIL — the row is suppressed by the `sameTurn` fallback.

- [ ] **Step 3: Rename in the reducer**

`RevealReducer.kt` — `RevealBubble.messageId` → `replyId`; `val key: String get() = replyId ?: turnId`; every `e.messageId` → `e.replyId`; `e.message.messageId` → `e.message.replyId`; `RevealState.tasks` type becomes `List<TaskListItem>` and `upsert` keys on `it.id` instead of `it.toolCallId`.

- [ ] **Step 4: Simplify the suppression**

`ObserveChatUseCase.kt` L103-112 becomes:

```kotlin
            // Hide ONLY the committed row this live bubble is painting, matched
            // on the reply and nothing else.
            //
            // The turn fallback this replaces was the bug: a row with no
            // replyId — a user row, a tool tile, an entry written before the
            // column existed — matched on turnId alone and vanished behind the
            // bubble for the length of the reveal. The gateway now folds a
            // reply into ONE committed item carrying its own replyId, so there
            // is exactly one row to hide and no reason to guess.
            val bubble = rs.bubble
            val visibleCommitted =
                if (bubble?.replyId == null) {
                    committed
                } else {
                    committed.filter { it.replyId != bubble.replyId }
                }
```
and the live bubble construction uses `replyId = it.replyId`.

- [ ] **Step 5: Update `ChatModel`**

`tasks` becomes `List<TaskListItem>`. `messagesForUi()` becomes:

```kotlin
    /** Committed rows plus the live bubble. Tool rows are NOT here — they are
     *  the composer strip's, fed straight from `tasks`. */
    fun messagesForUi(): List<ChatMessage> = if (live == null) committed else committed + live
```

- [ ] **Step 6: Run and commit**

```bash
source scripts/env.sh && ./gradlew :shared:mobile-data:allTests :shared:mobile-sdk:allTests
git add -A && git commit -m "fix(mobile-data): suppress the committed twin by reply, never by turn"
```

---

# Slice E — Native UI

---

### Task 12: iOS — composer task strip

**Files:**
- Create: `ios/App/Chat/composer/ComposerTaskStrip.swift`
- Delete: `ios/App/Chat/tool/ToolPillStrip.swift` (content moves)
- Modify: `ios/App/Chat/composer/Composer.swift:45-75` (input), `:117-123` (card stack)
- Modify: `ios/App/Chat/message/MessageBubble.swift:96-113` (drop pills), `:180-199` + previews
- Modify: `ios/App/Chat/ChatView.swift:131-135` (derive tasks), `:281-296` (pass them)
- Modify: `ios/App/Chat/message/MessageList.swift:254-256` (preview fixtures)

**Interfaces:**
- Consumes: `ChatModel.tasks: [TaskListItem]` (Task 11).
- Produces: `ComposerTaskStrip(items: [TaskListItem])`; `Composer` gains `let tasks: [TaskListItem]`.

- [ ] **Step 1: Move and rewrite the strip**

`git mv ios/App/Chat/tool/ToolPillStrip.swift ios/App/Chat/composer/ComposerTaskStrip.swift`. Rename the struct to `ComposerTaskStrip`, change `let tools: [TaskSnapshotItem]` to `let items: [TaskListItem]`, key `openId` on `item.id`, expand the detail panel ABOVE the pills, drop the negative-padding bleed (`:25-27`) since it now sits inside the composer card, and return `EmptyView()` when `items.isEmpty`. Add `.accessibilityIdentifier("task-strip")` on the container and `.accessibilityIdentifier("task-pill-\(item.id)")` on each pill — the audit found zero test ids on pills, so e2e cannot see them today.

- [ ] **Step 2: Render it in the composer**

`Composer.swift` — add `let tasks: [TaskListItem]` to the inputs, and make it the first child of the card's `VStack` (`:118`), above `micDeniedRow`.

- [ ] **Step 3: Strip the bubble**

`MessageBubble.swift` — delete line `:111` (`if !message.tools.isEmpty { ToolPillStrip(...) }`), the `sampleTools` fixture (`:180-199`), and update every `#Preview` `ChatMessage(...)` call: drop the `tools:` argument and rename `messageId:` → `replyId:`. Same rename in `MessageList.swift:254-256`.

- [ ] **Step 4: Pass the list down**

`ChatView.swift` — add `private var tasks: [TaskListItem] { vm.state.model.tasks }` beside `displayMessages` (`:131`), and pass `tasks: tasks` into `Composer(...)` at `:281`.

- [ ] **Step 5: Build**

```bash
source scripts/env.sh && ./scripts/ios-setup.sh && xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.3.1' build 2>&1 | tail -20
```
Expected: `BUILD SUCCEEDED`.

> **Project/scheme names.** It is `ios/SentientApp.xcodeproj`, scheme `SentientApp` — there is no
> `Sentient.xcodeproj` and no `Sentient` scheme anywhere in the repo (`ios-setup.sh` generates the
> `SentientApp` names). The destination also needs an explicit `OS=`: two iPhone-16 simulators are
> installed, so a bare `name=iPhone 16` is ambiguous and xcodebuild fails to resolve it. `OS=18.3.1`
> is verified working.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(ios): render tool rows in the composer strip, not on the bubble"
```

---

### Task 13: Android — composer task strip

**Files:**
- Create: `android/src/main/kotlin/io/sentient/android/chat/composer/ComposerTaskStrip.kt`
- Delete: `android/src/main/kotlin/io/sentient/android/chat/tool/ToolPillStrip.kt` (content moves)
- Modify: `.../chat/composer/Composer.kt:116-129` (params), `:211-232` (column)
- Modify: `.../chat/message/MessageBubble.kt:52`, `:57`, `:166`, `:173`, `:184`, `:228`
- Modify: `.../chat/ChatContent.kt:121-127`, `:189-205`

**Interfaces:**
- Consumes: `ChatModel.tasks: List<TaskListItem>` (Task 11).
- Produces: `ComposerTaskStrip(items: List<TaskListItem>)`; `Composer` gains `tasks: List<TaskListItem>`.

- [ ] **Step 1: Move and rewrite the strip**

`git mv` the file, rename the composable to `ComposerTaskStrip`, change the parameter to `items: List<TaskListItem>`, key `openId` on `t.id`, put the args-preview panel ABOVE the pill row, return early when `items.isEmpty()`, and add `Modifier.testTag("task-strip")` on the container plus `testTag("task-pill-${t.id}")` on each pill.

- [ ] **Step 2: Render it in the composer**

`Composer.kt` — add `tasks: List<TaskListItem>` to the params and make `ComposerTaskStrip(tasks)` the first child of the `Column` at `:211`, above the mic-denied notice.

- [ ] **Step 3: Strip the bubble**

`MessageBubble.kt` — delete the `ToolPillStrip` import (`:52`), the `TaskSnapshotItem` import (`:57`), the render at `:166`, the `tools = message.tools` pass-through at `:173`, the `tools` parameter on `BubbleText` (`:184`), and the render at `:228`.

- [ ] **Step 4: Pass the list down**

`ChatContent.kt` — `:123` becomes `val live = uiState.model.live` (no `.copy(tools = …)`), and `Composer(...)` at `:189` gains `tasks = uiState.model.tasks`.

- [ ] **Step 5: Build**

```bash
source scripts/env.sh && ./gradlew :android:assembleDebug :android:testDebugUnitTest
```
Expected: BUILD SUCCESSFUL, all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(android): render tool rows in the composer strip, not on the bubble"
```

---

# Slice F — Retire the old path and verify

---

### Task 14: Delete `turn.tool.update` and the tool feed item

Every client now reads `tasklist.state`. The dual-emit scaffolding comes out.

**Files:**
- Modify: `shared/protocol/src/messages.ts` (delete `turnToolUpdateSchema`, `turnToolStatusSchema` moves next to `taskListItemSchema`)
- Modify: `shared/protocol/src/conversation.ts` (delete `conversationFeedToolItemSchema` from the union)
- Modify: `gateway/src/session-handlers/frame-lanes.ts` (delete the `turn.tool.update` line)
- Modify: `gateway/src/runtime/turn-emitter.ts`, `gateway/src/session-handlers/ws-turn-emitter.ts` (delete `toolUpdate`)
- Modify: `gateway/src/runtime/session-runtime.ts` (drop the `emitter.toolUpdate` call, keep the projector call)
- Modify: `gateway/src/store/client-projection.ts` (delete the `tool_call` / `tool_result` branches and `toolItemIndexByCallId`)
- Modify: `gateway/src/runtime/conversation-feed.ts` (delete `unresolvedToolItemIds`, `TOOL_STATUS_*`, the `tool` case in `toWireItem`, the `isUnresolvedTool` argument)
- Modify: `shared/web-sdk/src/index.ts`; delete `shared/web-sdk/src/connectors/tool-status-connector.ts` + its test
- Modify: `shared/mobile-sdk/.../protocol/ServerMessage.kt` (delete `TurnToolUpdate`), `.../protocol/ConversationFeedItem.kt` (delete `Tool`)

**Interfaces:**
- Consumes: everything above.
- Produces: a wire with no tool tiles and no per-call update frame.

- [ ] **Step 1: Delete gateway-side**

Remove every symbol listed. In `conversation-feed.ts`, `publish()` keeps only the open-reply hold-back — `force` now means "release the still-open reply at a turn boundary" and nothing else. Update the module header to say so; delete the paragraphs about tool tiles not being content-final.

In `client-projection.ts`, tool entries become a plain `continue` alongside `system`/`compaction`:

```ts
    // Tool entries are the MODEL's record of what it called, replayed to it by
    // the model projection. They are not user-facing artifacts: live tool
    // activity is the composer task strip (runtime/task-list.ts), which is
    // ephemeral by design. Keeping them here is what forced a tile to anchor to
    // a bubble, and that anchor is what broke once a steer could split a reply.
    if (entry.kind === "system" || entry.kind === "compaction") continue;
    if (entry.kind === "tool_call" || entry.kind === "tool_result") continue;
```

- [ ] **Step 2: Delete client-side**

web-sdk: delete `tool-status-connector.ts` and its test, and the exports. mobile-sdk: delete `ServerMessage.TurnToolUpdate` and `ConversationFeedItem.Tool`; fix the `when` branches that referenced them.

- [ ] **Step 3: Prove nothing references the old names**

```bash
source scripts/env.sh
rg -n 'turn\.tool\.update|ToolStatusConnector|TaskStatusConnector|TaskSnapshotItem|messageId|message_id|toCommittedTile|attachLiveTools|attachToolsToAssistantMessages' \
   gateway/src gateway/webui/src shared android/src ios/App --glob '!**/build/**'
```
Expected: **zero hits.** Any hit is an incomplete deletion — fix it, do not narrow the grep.

- [ ] **Step 4: Full CI**

```bash
source scripts/env.sh && bun run ci
cd gateway/src && bun test && cd ../..
./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests :android:testDebugUnitTest
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(protocol): retire turn.tool.update and the tool feed item"
```

---

### Task 15: End-to-end verification

**Files:**
- Modify: `qa/mobile/flows/ios/01-send-stream.yaml`, `qa/mobile/flows/android/01-send-stream.yaml` (assert the strip)
- Modify: `agents/docs/testing-knowledge.md` (add the reusable cases)

- [ ] **Step 1: Boot the local stack**

```bash
source scripts/env.sh && bun run dev
```
Wait for the gateway to report ready, then confirm with `bun run stack:status`.

- [ ] **Step 2: Run the web matrix via Playwright MCP against `https://localhost`**

Both viewports: desktop 1280×900 and mobile-sized 390×844 (`browser_resize`).

- [ ] **Step 3: Run the native matrix**

```bash
source scripts/env.sh && qa/mobile/run-e2e.sh android --tags chat
source scripts/env.sh && qa/mobile/run-e2e.sh ios --tags chat
```

> **Tags.** `chat-stream` and `tool-strip` do not exist in the taxonomy and select nothing. The
> surface tag is `chat` (see `agents/docs/testing-knowledge.md` § "Tag taxonomy"), which selects
> `01-send-stream` and its paired `01b-reply-survives-relaunch` — the two flows that carry this
> work's assertions. `01b` is deliberately tagged `chat` ONLY: it asserts against the conversation
> `01-send-stream` creates, and `CANONICAL_ORDER` keeps the pair adjacent, so any tag set that would
> select `01b` without `01-send-stream` must be avoided.
>
> **Safety note.** `12-permission-confirm` is also tagged `chat`, but it additionally carries the
> `device-actuating` behavior tag (added 2026-08-06 after it turned on a real kitchen light on an
> unattended `--tags chat` run) — `run-e2e.sh`'s `BASE_EXCLUDE` keeps `device-actuating` flows out
> of every `--tags` batch unconditionally, so the invocation above cannot select it.

- [ ] **Step 4: Record evidence and update the case library**

Screenshots + console + network under the Playwright output dir; Maestro output + simulator screenshots + the `os_log`/`logcat` trail under the mobile QA dir. Add `multi-stretch reply renders one bubble` and `composer task strip clears at the turn boundary` to `agents/docs/testing-knowledge.md`, indexed by surface.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(e2e): pin one-bubble replies and the composer task strip"
```

## E2E matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Multi-stretch reply is one bubble | desktop 1280×900 | fresh chat, stack up | Send "list my media players and play something on the kitchen speaker" (drives narration → tool → narration → tool → answer) | ONE assistant bubble grows through the whole turn; when the typewriter finishes it does not split, re-order, or change row count | `session-runtime.turn.start`; several `conversation-feed.published` with `published:0` while the reply is open; exactly ONE `conversation.entry` of `kind:"assistant"` for the turn; no WARN |
| Reply survives reload | desktop 1280×900 | the turn above, completed | Reload the page | The same single bubble, same text, same position | `conversation-feed.snapshot` with one assistant item for that turn |
| Mid-turn steer splits the reply | desktop 1280×900 | a turn in flight, mid-narration | Type a second message and send it | First bubble closes where it was; the user row renders below it; the reply resumes in a NEW bubble under that row | `session-runtime.reply.rotated` with `previousReplyId` ≠ `replyId`; `session-runtime.submit.steer` |
| Task strip shows live rows | desktop 1280×900 | fresh chat | Send a message that calls two tools | Pills appear at the top of the composer, inside its border, transitioning running → done; NO pills on any chat bubble | `task-list.tool-update` per transition; `turn-emitter.task-list` with matching `count` |
| Task strip clears at the turn boundary | desktop 1280×900 | the turn above, completing | Wait for `turn.completed` | Strip empties; composer returns to its normal height with no layout jump | `task-list.turn-ended`; final `turn-emitter.task-list` with `count:0` |
| Background task outlives its turn | desktop 1280×900 | fresh chat | Send a message that triggers `delegateTask` | Its pill REMAINS in the strip after the turn completes and after the next turn starts; it leaves when the delegation settles | `task-list.turn-ended` with a non-zero `rows`; later `task-list.delegation-settled` |
| Mid-turn attach agrees | desktop 1280×900 + second tab | a turn in flight | Open a second tab on the same session | The second tab shows the same single growing bubble and the same strip rows; when the turn ends neither tab duplicates the reply | `conversation-feed.snapshot`; `turn-emitter.task-list` on the attach; no duplicate `entryId` in either mirror |
| Narrow viewport strip | mobile-sized 390×844 | fresh chat | Send a two-tool message | Strip wraps or scrolls inside the composer; the page body never scrolls horizontally | as above |
| iOS multi-stretch reply | iPhone 16 simulator | logged in, fresh chat | `01-send-stream` with the two-tool prompt | one `assistant-bubble`, `task-strip` visible during the turn and gone after | `os_log`: `connector.task-list state count=…`; no `inflight-message` warn |
| Android multi-stretch reply | Pixel emulator | logged in, fresh chat | `01-send-stream` with the two-tool prompt | one `assistant-bubble`, `task-strip` visible during the turn and gone after | `logcat`: `connector.task-list state count=…` |
| Mobile reload agrees | both simulators | completed turn | Kill and relaunch the app | Same single assistant bubble; strip empty | REST `sessions.messages` with one assistant item per reply |

---

## Self-review notes

- **Spec coverage.** The four decisions agreed in the design conversation each map to a task: rename to `replyId` → Task 1; `replyId` on the item → Task 2; fold one reply into one item → Task 3; server-authoritative full-state task list → Tasks 4–6; dumb clients → Tasks 7–13; retire the old path → Task 14.
- **The red test that started this** (`gateway/src/runtime/reply-bubble-convergence.test.ts`) goes green at the end of Task 3. Slice A is independently shippable.
- **Dual-emit window.** `turn.tool.update` and the tool feed item stay alive from Task 6 through Task 13 so every intermediate commit is green; Task 14 removes them.
- **Known gap the inventory surfaced, deliberately not fixed here:** `StateDeriver.deriveTimeline()` passes `inflight = null`, so the SDK's `timeline` never carries the live bubble — mobile's live bubble comes from `ObserveChatUseCase`'s reveal instead. That asymmetry is pre-existing and orthogonal; leave it.
