# Session History Segment Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild SessionHistory with a rich per-segment data model so that Deepgram's multi-segment `isFinal` events accumulate correctly instead of overwriting each other.

**Architecture:** Replace flat `Segment { role, text }` with a `HistoryEntry` struct carrying id, role, text, state (partial/final), confidence, and timestamps. `amendPendingUser` changes from "replace ALL pending user segments" to "finalize the current partial segment" — previously finalized segments are never touched. A single `currentPartial` field replaces the old `Draft`. All public API signatures stay identical; only internal storage and `amendPendingUser` semantics change.

**Tech Stack:** TypeScript, Vitest

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Rewrite | `gateway/src/context/session-history.ts` | Rich `HistoryEntry` model, segment-aware storage |
| Create | `gateway/src/context/session-history.test.ts` | Dedicated unit tests (currently has none) |
| Verify | `gateway/src/pipeline/continuous-session.ts` | Caller — no changes expected, just verify |
| Verify | `gateway/src/pipeline/barge-in-integration.test.ts` | Existing integration tests must still pass |
| Verify | `gateway/src/pipeline/continuous-session.test.ts` | Existing session tests must still pass |

---

## Data Model

```ts
type EntryState = "partial" | "final";

interface HistoryEntry {
  readonly id: number;
  readonly role: "user" | "assistant";
  text: string;
  state: EntryState;
  confidence: number;       // 0.0–1.0 from STT; 1.0 for assistant
  readonly createdAt: number; // Date.now() epoch ms
  updatedAt: number;
}
```

**Storage:**
- `entries: HistoryEntry[]` — all entries (partial + final). At most one partial at the end.
- No separate `draft` field — the current partial IS the last entry when `state === "partial"`.

**Key semantic change:**
- OLD `amendPendingUser(text)`: pop ALL user segments after last assistant → push one replacement.
- NEW `amendPendingUser(text)`: if the last entry is a partial user entry, promote it to final with the new text. If the last entry is already final (or assistant), push a new final user entry. Never touch previously finalized entries.

---

### Task 1: Write HistoryEntry type + factory skeleton with first test

**Files:**
- Create: `gateway/src/context/session-history.test.ts`
- Modify: `gateway/src/context/session-history.ts`

- [ ] **Step 1: Write the first test — append and read back**

```ts
// gateway/src/context/session-history.test.ts
import { describe, expect, it } from "vitest";
import { createSessionHistory } from "./session-history.ts";

describe("SessionHistory", () => {
  describe("append + messages", () => {
    it("appends a final entry and returns it via messages()", () => {
      const h = createSessionHistory();
      h.append("user", "Hello");
      const msgs = h.messages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toEqual({ role: "user", content: "Hello" });
    });

    it("merges adjacent same-role appends into one message", () => {
      const h = createSessionHistory();
      h.append("user", "I want to learn");
      h.append("user", "about philosophy");
      const msgs = h.messages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]?.content).toBe("I want to learn about philosophy");
    });

    it("separates messages at role boundaries", () => {
      const h = createSessionHistory();
      h.append("user", "Hello");
      h.append("assistant", "Hi there");
      h.append("user", "Tell me about dogs");
      const msgs = h.messages();
      expect(msgs).toHaveLength(3);
      expect(msgs[0]).toEqual({ role: "user", content: "Hello" });
      expect(msgs[1]).toEqual({ role: "assistant", content: "Hi there" });
      expect(msgs[2]).toEqual({ role: "user", content: "Tell me about dogs" });
    });

    it("ignores empty text on append", () => {
      const h = createSessionHistory();
      h.append("user", "");
      h.append("user", "  ");
      expect(h.messages()).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes with existing implementation**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: PASS (append/messages behavior is unchanged)

- [ ] **Step 3: Add the HistoryEntry type and entryId counter to session-history.ts**

Replace the existing `Segment` and `Draft` interfaces and the factory internals:

```ts
// gateway/src/context/session-history.ts

// Replace the Segment and Draft interfaces with:
type EntryState = "partial" | "final";

export interface HistoryEntry {
  readonly id: number;
  readonly role: "user" | "assistant";
  text: string;
  state: EntryState;
  confidence: number;
  readonly createdAt: number;
  updatedAt: number;
}

// Replace factory internals — change:
//   const segments: Segment[] = [];
//   let draft: Draft | null = null;
// To:
//   const entries: HistoryEntry[] = [];
//   let nextId = 1;
```

Keep all public method signatures identical. Internally, entries replaces both segments and draft. A partial entry (`state === "partial"`) is the equivalent of the old draft.

- [ ] **Step 4: Rewrite `append()` to create final HistoryEntry**

```ts
append(role: "user" | "assistant", text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  // If there's a partial of the same role, remove it — the append supersedes it
  const last = entries[entries.length - 1];
  if (last?.role === role && last.state === "partial") {
    entries.pop();
  }

  const now = Date.now();
  log.debug("append", { role, length: trimmed.length });
  entries.push({
    id: nextId++,
    role,
    text: trimmed,
    state: "final",
    confidence: role === "assistant" ? 1.0 : 0,
    createdAt: now,
    updatedAt: now,
  });
},
```

- [ ] **Step 5: Rewrite `messages()` to merge entries**

```ts
messages(): readonly ConversationTurn[] {
  if (entries.length === 0) return [];

  const merged: ConversationTurn[] = [];
  const first = entries[0];
  if (!first) return [];
  let current = { role: first.role, parts: [first.text] };

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.role === current.role) {
      current.parts.push(entry.text);
    } else {
      merged.push({ role: current.role, content: current.parts.join(" ") });
      current = { role: entry.role, parts: [entry.text] };
    }
  }

  merged.push({ role: current.role, content: current.parts.join(" ") });
  return merged;
},
```

- [ ] **Step 6: Rewrite `clear()`**

```ts
clear(): void {
  entries.length = 0;
},
```

- [ ] **Step 7: Run tests**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add gateway/src/context/session-history.ts gateway/src/context/session-history.test.ts
git commit -m "refactor(history): add HistoryEntry type, rewrite append/messages/clear"
```

---

### Task 2: Rewrite setDraft and clearDraft using partial entries

**Files:**
- Modify: `gateway/src/context/session-history.ts`
- Modify: `gateway/src/context/session-history.test.ts`

- [ ] **Step 1: Write tests for setDraft and clearDraft**

```ts
// Add to session-history.test.ts
describe("setDraft + clearDraft", () => {
  it("setDraft creates a partial entry visible in messages()", () => {
    const h = createSessionHistory();
    h.setDraft("user", "hello");
    const msgs = h.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: "user", content: "hello" });
  });

  it("setDraft replaces previous partial of same role", () => {
    const h = createSessionHistory();
    h.setDraft("user", "hel");
    h.setDraft("user", "hello");
    const msgs = h.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe("hello");
  });

  it("setDraft with empty text removes existing partial", () => {
    const h = createSessionHistory();
    h.setDraft("user", "hello");
    h.setDraft("user", "");
    expect(h.messages()).toHaveLength(0);
  });

  it("clearDraft removes partial entry", () => {
    const h = createSessionHistory();
    h.setDraft("user", "hello");
    h.clearDraft();
    expect(h.messages()).toHaveLength(0);
  });

  it("clearDraft does not remove final entries", () => {
    const h = createSessionHistory();
    h.append("user", "Hello");
    h.setDraft("user", "world");
    h.clearDraft();
    const msgs = h.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe("Hello");
  });

  it("partial merges with preceding final of same role in messages()", () => {
    const h = createSessionHistory();
    h.append("user", "Yeah. But");
    h.setDraft("user", "how would you apply");
    const msgs = h.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe("Yeah. But how would you apply");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: FAIL (setDraft/clearDraft not yet rewritten)

- [ ] **Step 3: Implement setDraft using partial entries**

```ts
setDraft(role: "user" | "assistant", text: string): void {
  const trimmed = text.trim();
  const last = entries[entries.length - 1];

  // Remove existing partial of same role
  if (last?.role === role && last.state === "partial") {
    entries.pop();
  }

  if (!trimmed) return;

  const now = Date.now();
  entries.push({
    id: nextId++,
    role,
    text: trimmed,
    state: "partial",
    confidence: 0,
    createdAt: now,
    updatedAt: now,
  });
},
```

- [ ] **Step 4: Implement clearDraft — remove the last entry if it's partial**

```ts
clearDraft(): void {
  const last = entries[entries.length - 1];
  if (last?.state === "partial") {
    entries.pop();
  }
},
```

- [ ] **Step 5: Run tests**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add gateway/src/context/session-history.ts gateway/src/context/session-history.test.ts
git commit -m "refactor(history): rewrite setDraft/clearDraft using partial entries"
```

---

### Task 3: Rewrite amendPendingUser — the critical fix

**Files:**
- Modify: `gateway/src/context/session-history.ts`
- Modify: `gateway/src/context/session-history.test.ts`

- [ ] **Step 1: Write the critical test — multi-segment isFinal accumulation**

This is the exact bug scenario from the logs: Deepgram sends 3 isFinal segments for one utterance.

```ts
// Add to session-history.test.ts
describe("amendPendingUser", () => {
  it("promotes current partial to final without destroying previous finals", () => {
    const h = createSessionHistory();

    // Deepgram segment 1: partials then isFinal
    h.setDraft("user", "Yeah. But how would you apply");
    h.amendPendingUser("Yeah. But");

    // Deepgram segment 2: partials then isFinal
    h.setDraft("user", "how would you apply this to life and just as a");
    h.amendPendingUser("how would you apply this to life and just");

    // Deepgram segment 3: partials then isFinal
    h.setDraft("user", "as a individual then?");
    h.amendPendingUser("as a individual then?");

    // All three segments must be preserved
    expect(h.pendingUserText()).toBe(
      "Yeah. But how would you apply this to life and just as a individual then?"
    );
  });

  it("replaces partial but keeps all prior finals", () => {
    const h = createSessionHistory();
    h.amendPendingUser("Hello");
    h.setDraft("user", "world draft");
    h.amendPendingUser("world final");
    expect(h.pendingUserText()).toBe("Hello world final");
  });

  it("works after assistant response — new user turn", () => {
    const h = createSessionHistory();
    h.append("user", "first turn");
    h.append("assistant", "response");
    h.setDraft("user", "second turn partial");
    h.amendPendingUser("second turn final");
    expect(h.pendingUserText()).toBe("second turn final");
    expect(h.messages()).toHaveLength(3);
  });

  it("ignores empty text", () => {
    const h = createSessionHistory();
    h.amendPendingUser("Hello");
    h.amendPendingUser("");
    expect(h.pendingUserText()).toBe("Hello");
  });

  it("amend without prior partial creates a new final entry", () => {
    const h = createSessionHistory();
    h.amendPendingUser("direct final");
    expect(h.pendingUserText()).toBe("direct final");
    const msgs = h.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toBe("direct final");
  });
});
```

- [ ] **Step 2: Run tests to verify the critical test fails**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: FAIL — "promotes current partial to final without destroying previous finals" fails because old `amendPendingUser` wipes all pending segments.

- [ ] **Step 3: Implement the new amendPendingUser**

```ts
amendPendingUser(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const last = entries[entries.length - 1];
  const now = Date.now();

  // If the last entry is a partial user entry, replace it with a final
  if (last?.role === "user" && last.state === "partial") {
    entries.pop();
  }

  log.debug("amend-pending-user", { text: trimmed.slice(0, 50) });
  entries.push({
    id: nextId++,
    role: "user",
    text: trimmed,
    state: "final",
    confidence: 0,
    createdAt: now,
    updatedAt: now,
  });
},
```

- [ ] **Step 4: Run tests**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/context/session-history.ts gateway/src/context/session-history.test.ts
git commit -m "fix(history): amendPendingUser preserves prior final segments"
```

---

### Task 4: Rewrite pendingUserText and hasPendingUserSpeech

**Files:**
- Modify: `gateway/src/context/session-history.ts`
- Modify: `gateway/src/context/session-history.test.ts`

- [ ] **Step 1: Write tests**

```ts
// Add to session-history.test.ts
describe("pendingUserText + hasPendingUserSpeech", () => {
  it("returns empty when no entries", () => {
    const h = createSessionHistory();
    expect(h.pendingUserText()).toBe("");
    expect(h.hasPendingUserSpeech()).toBe(false);
  });

  it("returns user text after last assistant message", () => {
    const h = createSessionHistory();
    h.append("user", "first");
    h.append("assistant", "reply");
    h.append("user", "second");
    expect(h.pendingUserText()).toBe("second");
    expect(h.hasPendingUserSpeech()).toBe(true);
  });

  it("concatenates multiple pending user segments", () => {
    const h = createSessionHistory();
    h.append("assistant", "reply");
    h.amendPendingUser("segment one");
    h.amendPendingUser("segment two");
    h.setDraft("user", "partial three");
    expect(h.pendingUserText()).toBe("segment one segment two partial three");
  });

  it("includes partial in hasPendingUserSpeech", () => {
    const h = createSessionHistory();
    h.setDraft("user", "typing...");
    expect(h.hasPendingUserSpeech()).toBe(true);
  });

  it("returns false after assistant appends", () => {
    const h = createSessionHistory();
    h.append("user", "question");
    h.append("assistant", "answer");
    expect(h.hasPendingUserSpeech()).toBe(false);
    expect(h.pendingUserText()).toBe("");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: PASS or FAIL depending on whether prior steps already handle this

- [ ] **Step 3: Implement pendingUserText using entries array**

```ts
pendingUserText(): string {
  const parts: string[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.role === "assistant") break;
    parts.unshift(entry.text);
  }
  return parts.join(" ").trim();
},
```

- [ ] **Step 4: Implement hasPendingUserSpeech**

```ts
hasPendingUserSpeech(): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.role === "assistant") return false;
    if (entry.text.trim()) return true;
  }
  return false;
},
```

- [ ] **Step 5: Run tests**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add gateway/src/context/session-history.ts gateway/src/context/session-history.test.ts
git commit -m "refactor(history): rewrite pendingUserText/hasPendingUserSpeech for entry model"
```

---

### Task 5: Add confidence to amendPendingUser + expose entries()

**Files:**
- Modify: `gateway/src/context/session-history.ts`
- Modify: `gateway/src/context/session-history.test.ts`
- Modify: `gateway/src/pipeline/continuous-session.ts`

- [ ] **Step 1: Write tests for confidence tracking and entries accessor**

```ts
// Add to session-history.test.ts
describe("confidence + entries", () => {
  it("amendPendingUser accepts optional confidence", () => {
    const h = createSessionHistory();
    h.amendPendingUser("Hello", 0.98);
    const all = h.entries();
    expect(all).toHaveLength(1);
    expect(all[0]?.confidence).toBe(0.98);
    expect(all[0]?.state).toBe("final");
    expect(all[0]?.role).toBe("user");
  });

  it("append sets confidence to 1.0 for assistant", () => {
    const h = createSessionHistory();
    h.append("assistant", "Hi");
    const all = h.entries();
    expect(all).toHaveLength(1);
    expect(all[0]?.confidence).toBe(1.0);
  });

  it("entries returns all entries with timestamps", () => {
    const h = createSessionHistory();
    h.amendPendingUser("seg1", 0.95);
    h.amendPendingUser("seg2", 0.99);
    const all = h.entries();
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(1);
    expect(all[1]?.id).toBe(2);
    expect(all[0]?.createdAt).toBeGreaterThan(0);
    expect(all[1]?.createdAt).toBeGreaterThanOrEqual(all[0]!.createdAt);
  });

  it("entries is a snapshot — mutations don't affect history", () => {
    const h = createSessionHistory();
    h.append("user", "Hello");
    const snap = h.entries();
    snap.length = 0; // mutate the snapshot
    expect(h.entries()).toHaveLength(1); // original unaffected
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && bun test src/context/session-history.test.ts`
Expected: FAIL — `entries()` method doesn't exist yet, `amendPendingUser` doesn't accept confidence

- [ ] **Step 3: Update SessionHistory interface**

Add to the `SessionHistory` interface:

```ts
/** Replace the current partial user segment with a finalized version.
 *  Previously finalized segments are preserved. */
amendPendingUser(text: string, confidence?: number): void;

/** Read-only snapshot of all entries (for debugging / metrics). */
entries(): readonly HistoryEntry[];
```

Export the `HistoryEntry` type and `EntryState` type from the module.

- [ ] **Step 4: Update amendPendingUser implementation to accept confidence**

```ts
amendPendingUser(text: string, confidence?: number): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const last = entries[entries.length - 1];
  const now = Date.now();

  if (last?.role === "user" && last.state === "partial") {
    entries.pop();
  }

  log.debug("amend-pending-user", { text: trimmed.slice(0, 50) });
  entries.push({
    id: nextId++,
    role: "user",
    text: trimmed,
    state: "final",
    confidence: confidence ?? 0,
    createdAt: now,
    updatedAt: now,
  });
},
```

- [ ] **Step 5: Add entries() accessor**

```ts
entries(): readonly HistoryEntry[] {
  return [...entries];
},
```

Note: The internal array and the method share a name. Rename the internal array to `_entries` or use a different accessor pattern. Simplest: rename the internal array to `store`:

```ts
const store: HistoryEntry[] = [];
// ... all internal references change from entries to store
// The public method:
entries(): readonly HistoryEntry[] {
  return [...store];
},
```

- [ ] **Step 6: Pass confidence from continuous-session.ts**

In `gateway/src/pipeline/continuous-session.ts`, line ~414, change:

```ts
// Before:
if (event.text.trim()) history.amendPendingUser(event.text);

// After:
if (event.text.trim()) history.amendPendingUser(event.text, event.confidence);
```

- [ ] **Step 7: Run all tests**

Run: `cd gateway && bun test`
Expected: PASS — all existing tests + new tests pass

- [ ] **Step 8: Commit**

```bash
git add gateway/src/context/session-history.ts gateway/src/context/session-history.test.ts gateway/src/pipeline/continuous-session.ts
git commit -m "feat(history): add confidence tracking, expose entries() accessor"
```

---

### Task 6: Delete old mergeSegments function + cleanup

**Files:**
- Modify: `gateway/src/context/session-history.ts`

- [ ] **Step 1: Remove the old `mergeSegments` standalone function**

The merge logic is now inline in `messages()`. Delete the `mergeSegments` function and the old `Segment`/`Draft` interfaces if they still exist. Ensure no dead code remains.

- [ ] **Step 2: Run all tests**

Run: `cd gateway && bun test`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `cd gateway && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add gateway/src/context/session-history.ts
git commit -m "refactor(history): remove dead Segment/Draft types and mergeSegments"
```

---

### Task 7: Verify all existing tests pass — integration check

**Files:**
- Verify: `gateway/src/pipeline/barge-in-integration.test.ts`
- Verify: `gateway/src/pipeline/continuous-session.test.ts`
- Verify: `gateway/src/server/continuous-voice-handler.test.ts`
- Verify: `gateway/src/server/continuous-voice-handler-turns.test.ts`

- [ ] **Step 1: Run the full gateway test suite**

Run: `cd gateway && bun test`
Expected: ALL PASS

Key tests to watch:
- `barge-in-integration.test.ts` — uses `append`, `pendingUserText`, `messages`, `hasPendingUserSpeech`
- `continuous-session.test.ts` — tests `speechEnd` event which reads `pendingUserText`
- `continuous-voice-handler-turns.test.ts` — uses `createSessionHistory()`

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS across all packages

- [ ] **Step 3: Fix any failing tests**

If `continuous-session.test.ts` "emits speechEnd on speechFinal=true" fails:
This test at line 263 sends two isFinal transcripts: `"hello"` then `"world"`. Under the old model, `amendPendingUser("world")` replaced `"hello"`. Under the new model, both are preserved → `pendingUserText()` returns `"hello world"`. The test already expects `"hello world"` (line 276), so it should pass.

If the test at line 26 (`barge-in-accepted` requiring `transcript_text`) fails — this is due to the barge-in controller change made earlier in this session, unrelated to this plan. The barge-in integration test sends `audio_received` but no `transcript_text`. Update the test to also send a `transcript_text` event:

```ts
controller.handle({ type: "transcript_text", timestampMs: 200 });
```

- [ ] **Step 4: Commit any test fixes**

```bash
git add -A
git commit -m "test: update integration tests for new history model + barge-in controller"
```
