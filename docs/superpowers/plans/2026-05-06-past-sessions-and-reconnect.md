# Past Sessions + Resume + Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Claude/ChatGPT-style hamburger sidebar over Hermes' existing SQLite-backed session store with click-to-resume, search, rename, delete, cross-tab sync, and reconnect rework on a single feature branch.

**Architecture:** Hermes upstream owns conversation history (`state.db`, FTS5, auto-titles, 90-day retention). Gateway adds a thin HTTP client to `/api/sessions/*`, a tiny per-profile JSON title-override store, a switch-flow state machine that rehydrates `ConversationMirror.replaceAll(history)`, and new WS frames (`sessions.list/search/delete/rename`, `session.new/switch/created/switched`). The browser keeps `currentSessionId` in `sessionStorage`; reconnect threads it through the WS connect URL. One additive overlay patch exposes Hermes' existing `source` filter on `GET /api/sessions`.

**Tech Stack:** Bun + TypeScript (strict) + Vitest + Biome (gateway, shared, web-sdk); Preact + signals (webui); Python (Hermes overlay patch); Playwright MCP (smoke).

**Spec:** `docs/superpowers/specs/2026-05-06-past-sessions-and-reconnect-design.md`
**Branch:** `feature/past-sessions-and-reconnect` (already exists; spec committed at `b5a7670`).

---

## File Map

**Hermes overlay (Python):**
- Modify: `deploy/hermes-overlay/sentient_gateway.py` (accept `session_id` on user.message; emit `session.created` / `session.switched`)
- Create: `deploy/hermes-overlay/patches/0010-sessions-source-filter.patch`
- Modify: `deploy/hermes-overlay/README.md` (document patch + source-tag convention)

**Shared protocol:**
- Create: `shared/protocol/src/sessions.ts` (SessionRow, zod schemas, request/result types)
- Create: `shared/protocol/src/sessions.test.ts`
- Modify: `shared/protocol/src/messages.ts` (export new schemas; add to message envelope)
- Modify: `shared/protocol/src/index.ts` (re-export sessions)

**Gateway:**
- Modify: `gateway/src/cerebrum/conversation-mirror.ts` (add `replaceAll`, `onSnapshot`)
- Modify: `gateway/src/cerebrum/conversation-mirror.test.ts` (snapshot fires once, append silenced)
- Create: `gateway/src/hermes-adapter-client/sessions-client.ts` (HTTP client)
- Create: `gateway/src/hermes-adapter-client/sessions-client.test.ts`
- Create: `gateway/src/sessions/title-store.ts` (per-profile JSON override store)
- Create: `gateway/src/sessions/title-store.test.ts`
- Create: `gateway/src/sessions/switch-flow.ts` (state machine)
- Create: `gateway/src/sessions/switch-flow.test.ts`
- Create: `gateway/src/session-handlers/sessions-handlers.ts` (WS frame router)
- Create: `gateway/src/session-handlers/sessions-handlers.test.ts`
- Modify: `gateway/src/hermes-adapter-client/event-translator.ts` (translate `session.created` / `session.switched`)
- Modify: `gateway/src/hermes-adapter-client/per-profile-connection.ts` (add `httpBaseUrl`)
- Modify: `gateway/src/session-handlers/ws-session-configure.ts` (read `?session_id=`, run resume on session-ready)
- Modify: `gateway/src/cerebrum/attention-gate.ts` (clear conversation salience on switch)
- Modify: `gateway/config.yaml` (`sessions:` block)

**SDK (browser):**
- Modify: `shared/web-sdk/src/connectors/conversation-history-connector.ts` (snapshot replaces; gen counter)
- Modify: `shared/web-sdk/src/connectors/conversation-history-connector.test.ts`
- Create: `shared/web-sdk/src/connectors/sessions-connector.ts`
- Create: `shared/web-sdk/src/connectors/sessions-connector.test.ts`
- Create: `shared/web-sdk/src/cross-tab-sync.ts` (BroadcastChannel)
- Modify: `shared/web-sdk/src/sdk-reconnect.ts` (append `session_id` query)
- Modify: `shared/web-sdk/src/sentient-sdk.ts` (wire SessionsConnector + cross-tab)

**WebUI (Preact):**
- Create: `gateway/webui/src/components/sessions/Drawer.tsx`
- Create: `gateway/webui/src/components/sessions/SessionList.tsx`
- Create: `gateway/webui/src/components/sessions/SessionRow.tsx`
- Create: `gateway/webui/src/components/sessions/SessionSearchBox.tsx`
- Create: `gateway/webui/src/components/sessions/DateGroupHeader.tsx`
- Create: `gateway/webui/src/components/sessions/NewChatButton.tsx`
- Create: `gateway/webui/src/hooks/use-sessions.ts`
- Modify: existing top-bar / hamburger button host (TBD by reading current chrome)
- Modify: `gateway/webui/src/state/chat-store.ts` or equivalent (snapshot rehydration wiring)

---

## Phase 0 — Foundation

### Task 0.1: Verify branch + spec is committed

**Files:** none (state check)

- [ ] **Step 1: Confirm branch + spec commit**

```bash
git rev-parse --abbrev-ref HEAD
git log --oneline -1 docs/superpowers/specs/2026-05-06-past-sessions-and-reconnect-design.md
```

Expected: branch is `feature/past-sessions-and-reconnect`; latest spec commit is `b5a7670`.

If branch differs:
```bash
git checkout feature/past-sessions-and-reconnect
```

---

## Phase 1 — Hermes overlay patch (source filter)

### Task 1.1: Build the source-filter patch

**Files:**
- Create: `deploy/hermes-overlay/patches/0010-sessions-source-filter.patch`

- [ ] **Step 1: Write the patch**

Place at `deploy/hermes-overlay/patches/0010-sessions-source-filter.patch`:

```patch
--- a/hermes_cli/web_server.py
+++ b/hermes_cli/web_server.py
@@ -716,12 +716,12 @@ async def _check_action_status(action_name: str) -> Dict[str, Any]:

 @app.get("/api/sessions")
-async def get_sessions(limit: int = 20, offset: int = 0):
+async def get_sessions(limit: int = 20, offset: int = 0, source: str = None):
     try:
         from hermes_state import SessionDB
         db = SessionDB()
         try:
-            sessions = db.list_sessions_rich(limit=limit, offset=offset)
+            sessions = db.list_sessions_rich(source=source, limit=limit, offset=offset)
             total = db.session_count()
             now = time.time()
             for s in sessions:
```

NOTE: The exact line numbers (`@@ -716,12`) may drift across upstream Hermes versions. Adjust by inspecting the current `hermes_cli/web_server.py` inside the running image:

```bash
docker run --rm --entrypoint sh nousresearch/hermes-agent:$(cat deploy/hermes-overlay/HERMES_VERSION) \
  -c 'sed -n "718,735p" /opt/hermes/hermes_cli/web_server.py'
```

- [ ] **Step 2: Update overlay README**

Open `deploy/hermes-overlay/README.md` and append (after the existing patch list) under a new section:

```markdown
### 0010-sessions-source-filter.patch

**Touches:** `hermes_cli/web_server.py:get_sessions`

**Change:** Adds optional `source: str = None` query param to `GET /api/sessions`; threads through to the existing `list_sessions_rich(source=...)` kwarg in `hermes_state.SessionDB`.

**Why additive-safe:** `list_sessions_rich` already accepts `source` upstream (`hermes_state.py` line ~793); we are only wiring the HTTP layer to expose it. Two-line change. Rebases trivially across upstream changes that don't rename the route handler or kwarg.

### Source tag conventions

The sentient adapter writes `source='sentient-user'` on every chain a real human starts via the gateway. The list UI filters on this exact value. Reserved future tags for gateway-originated runs that should NOT appear in the user-facing list:

- `sentient-system` — gateway-internal probes / health-check chains.
- `sentient-cron` — gateway-scheduled background runs.

When adding a new gateway-originated source, pick a tag from this namespace; never reuse `sentient-user`.
```

- [ ] **Step 3: Rebuild overlay image and verify the patch applies**

```bash
cd deploy/hermes-overlay
docker build -t sentient/hermes:local . 2>&1 | tail -20
```

Expected: build succeeds. If the patch fails to apply (`patch: **** malformed patch`), regenerate offsets by running the patch through `git apply --reject --whitespace=fix` interactively against an unpacked source tree.

- [ ] **Step 4: Verify the route accepts `?source=`**

```bash
docker run --rm -d --name hermes-source-test sentient/hermes:local
sleep 5
PORT=$(docker port hermes-source-test 8765/tcp 2>/dev/null | awk -F: '{print $2}' | head -1)
# Container's web_server port — adjust if your overlay uses a different port.
curl -sS "http://127.0.0.1:${PORT:-8765}/api/sessions?source=sentient-user&limit=1" | head
docker rm -f hermes-source-test
```

Expected: JSON response `{"sessions": [...], "total": ..., "limit": 1, "offset": 0}`. The list may be empty (no rows tagged `sentient-user` yet) — that's fine.

- [ ] **Step 5: Commit**

```bash
git add deploy/hermes-overlay/patches/0010-sessions-source-filter.patch \
        deploy/hermes-overlay/README.md
git commit -m "$(cat <<'EOF'
feat(hermes-overlay): expose source filter on GET /api/sessions

Two-line additive patch threads the existing `list_sessions_rich(source=...)`
kwarg out through the HTTP layer. README documents the patch and the
sentient-user / sentient-system / sentient-cron source-tag namespace.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Shared protocol (SessionRow + zod schemas)

### Task 2.1: Define SessionRow type + frame schemas

**Files:**
- Create: `shared/protocol/src/sessions.ts`
- Create: `shared/protocol/src/sessions.test.ts`
- Modify: `shared/protocol/src/index.ts`
- Modify: `shared/protocol/src/messages.ts`

- [ ] **Step 1: Write the failing test**

Create `shared/protocol/src/sessions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  sessionRowSchema,
  sessionsListSchema,
  sessionsListResultSchema,
  sessionsSearchSchema,
  sessionsDeleteSchema,
  sessionsRenameSchema,
  sessionNewSchema,
  sessionSwitchSchema,
  sessionCreatedEventSchema,
  sessionSwitchedEventSchema,
  sessionsErrorSchema,
} from "./sessions.ts";

describe("SessionRow", () => {
  it("parses a valid row with all fields", () => {
    const row = {
      sessionId: "abc",
      rootId: "root-abc",
      title: "Hello",
      startedAt: 1_700_000_000_000,
      lastActiveAt: 1_700_000_500_000,
      messageCount: 12,
      preview: "what's the weather",
      isActive: false,
    };
    expect(sessionRowSchema.parse(row)).toEqual(row);
  });

  it("rejects negative messageCount", () => {
    const bad = {
      sessionId: "abc",
      rootId: "root-abc",
      title: "x",
      startedAt: 0,
      lastActiveAt: 0,
      messageCount: -1,
      preview: "",
      isActive: false,
    };
    expect(sessionRowSchema.safeParse(bad).success).toBe(false);
  });
});

describe("sessions WS frames", () => {
  it("accepts sessions.list with positive bounds", () => {
    expect(
      sessionsListSchema.safeParse({
        type: "sessions.list",
        requestId: "r1",
        limit: 20,
        offset: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects sessions.list with limit > 100", () => {
    expect(
      sessionsListSchema.safeParse({
        type: "sessions.list",
        requestId: "r1",
        limit: 999,
        offset: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts sessions.search with non-empty query", () => {
    expect(
      sessionsSearchSchema.safeParse({
        type: "sessions.search",
        requestId: "r1",
        q: "weather",
        limit: 10,
      }).success,
    ).toBe(true);
  });

  it("accepts session.switch with sessionId", () => {
    expect(
      sessionSwitchSchema.safeParse({
        type: "session.switch",
        requestId: "r1",
        sessionId: "abc",
      }).success,
    ).toBe(true);
  });

  it("rejects sessions.rename with title > 200 chars", () => {
    expect(
      sessionsRenameSchema.safeParse({
        type: "sessions.rename",
        requestId: "r1",
        sessionId: "abc",
        title: "x".repeat(201),
      }).success,
    ).toBe(false);
  });

  it("rejects sessions.rename with control chars", () => {
    expect(
      sessionsRenameSchema.safeParse({
        type: "sessions.rename",
        requestId: "r1",
        sessionId: "abc",
        title: "helloworld",
      }).success,
    ).toBe(false);
  });

  it("accepts session.created event", () => {
    expect(
      sessionCreatedEventSchema.safeParse({
        type: "session.created",
        sessionId: "abc",
        title: "New chat",
        ts: 1_700_000_000_000,
      }).success,
    ).toBe(true);
  });

  it("accepts session.switched event", () => {
    expect(
      sessionSwitchedEventSchema.safeParse({
        type: "session.switched",
        sessionId: "abc",
        title: "Hello",
        ts: 1_700_000_000_000,
      }).success,
    ).toBe(true);
  });

  it("accepts sessions.error", () => {
    expect(
      sessionsErrorSchema.safeParse({
        type: "sessions.error",
        requestId: "r1",
        code: "forbidden",
        message: "not your session",
      }).success,
    ).toBe(true);
  });

  it("accepts sessions.list.result with empty items", () => {
    expect(
      sessionsListResultSchema.safeParse({
        type: "sessions.list.result",
        requestId: "r1",
        items: [],
        total: 0,
        hasMore: false,
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
source scripts/env.sh
cd shared/protocol && bun run test src/sessions.test.ts
```

Expected: FAIL — module `./sessions.ts` not found.

- [ ] **Step 3: Implement the schemas**

Create `shared/protocol/src/sessions.ts`:

```typescript
import { z } from "zod";

const TITLE_MAX = 200;
const QUERY_MAX = 200;
const LIST_LIMIT_MAX = 100;
const SEARCH_LIMIT_MAX = 50;

// SessionRow — the canonical client-facing shape for a chat thread.
export const sessionRowSchema = z.object({
  sessionId: z.string().min(1),
  rootId: z.string().min(1),
  title: z.string().max(TITLE_MAX),
  startedAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  preview: z.string(),
  isActive: z.boolean(),
});

export type SessionRow = z.infer<typeof sessionRowSchema>;

// Helper — disallow ASCII control characters in user-supplied titles.
const safeTitle = z
  .string()
  .max(TITLE_MAX)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char filter
  .refine((s) => !/[ -]/.test(s), {
    message: "title contains control characters",
  });

// Client → gateway: list a page of sessions.
export const sessionsListSchema = z.object({
  type: z.literal("sessions.list"),
  requestId: z.string().min(1),
  limit: z.number().int().positive().max(LIST_LIMIT_MAX),
  offset: z.number().int().nonnegative(),
});

// Gateway → client: list result.
export const sessionsListResultSchema = z.object({
  type: z.literal("sessions.list.result"),
  requestId: z.string().min(1),
  items: z.array(sessionRowSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

// Client → gateway: full-text search.
export const sessionsSearchSchema = z.object({
  type: z.literal("sessions.search"),
  requestId: z.string().min(1),
  q: z.string().min(1).max(QUERY_MAX),
  limit: z.number().int().positive().max(SEARCH_LIMIT_MAX),
});

// Gateway → client: search result.
export const sessionsSearchResultSchema = z.object({
  type: z.literal("sessions.search.result"),
  requestId: z.string().min(1),
  items: z.array(sessionRowSchema),
});

// Client → gateway: delete a session.
export const sessionsDeleteSchema = z.object({
  type: z.literal("sessions.delete"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
});

// Gateway → client: confirm + broadcast deletion.
export const sessionsDeletedEventSchema = z.object({
  type: z.literal("sessions.deleted"),
  sessionId: z.string().min(1),
});

// Client → gateway: rename a session.
export const sessionsRenameSchema = z.object({
  type: z.literal("sessions.rename"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  title: safeTitle,
});

// Gateway → client: confirm + broadcast rename.
export const sessionsRenamedEventSchema = z.object({
  type: z.literal("sessions.renamed"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX),
});

// Client → gateway: start a new chat.
export const sessionNewSchema = z.object({
  type: z.literal("session.new"),
  requestId: z.string().min(1),
});

// Gateway → client: a new session id was created (also emitted on first message of a fresh chain).
export const sessionCreatedEventSchema = z.object({
  type: z.literal("session.created"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX).optional(),
  ts: z.number().int().nonnegative(),
});

// Client → gateway: switch the active chain.
export const sessionSwitchSchema = z.object({
  type: z.literal("session.switch"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
});

// Gateway → client: confirms a switch — followed by a conversation.snapshot.
export const sessionSwitchedEventSchema = z.object({
  type: z.literal("session.switched"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX).optional(),
  ts: z.number().int().nonnegative(),
});

// Gateway → client: failure on any sessions.* request.
export const sessionsErrorSchema = z.object({
  type: z.literal("sessions.error"),
  requestId: z.string().min(1),
  code: z.enum(["forbidden", "not_found", "switching", "internal", "validation"]),
  message: z.string().max(500),
});

export type SessionsListMessage = z.infer<typeof sessionsListSchema>;
export type SessionsListResult = z.infer<typeof sessionsListResultSchema>;
export type SessionsSearchMessage = z.infer<typeof sessionsSearchSchema>;
export type SessionsSearchResult = z.infer<typeof sessionsSearchResultSchema>;
export type SessionsDeleteMessage = z.infer<typeof sessionsDeleteSchema>;
export type SessionsDeletedEvent = z.infer<typeof sessionsDeletedEventSchema>;
export type SessionsRenameMessage = z.infer<typeof sessionsRenameSchema>;
export type SessionsRenamedEvent = z.infer<typeof sessionsRenamedEventSchema>;
export type SessionNewMessage = z.infer<typeof sessionNewSchema>;
export type SessionCreatedEvent = z.infer<typeof sessionCreatedEventSchema>;
export type SessionSwitchMessage = z.infer<typeof sessionSwitchSchema>;
export type SessionSwitchedEvent = z.infer<typeof sessionSwitchedEventSchema>;
export type SessionsErrorEvent = z.infer<typeof sessionsErrorSchema>;
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd shared/protocol && bun run test src/sessions.test.ts
```

Expected: all 12 tests PASS.

- [ ] **Step 5: Wire into the protocol index + message envelope**

Open `shared/protocol/src/index.ts` and add:

```typescript
export * from "./sessions.ts";
```

Open `shared/protocol/src/messages.ts`. Find the existing message-envelope union (probably called `messageSchema` or `serverMessageSchema` / `clientMessageSchema`). Add the new schemas as members:

- Client → gateway union additions:
  `sessionsListSchema`, `sessionsSearchSchema`, `sessionsDeleteSchema`, `sessionsRenameSchema`, `sessionNewSchema`, `sessionSwitchSchema`
- Gateway → client union additions:
  `sessionsListResultSchema`, `sessionsSearchResultSchema`, `sessionsDeletedEventSchema`, `sessionsRenamedEventSchema`, `sessionCreatedEventSchema`, `sessionSwitchedEventSchema`, `sessionsErrorSchema`

Find the right `z.discriminatedUnion("type", [...])` blocks and append. Keep imports tidy.

- [ ] **Step 6: Run shared/protocol tests**

```bash
cd shared/protocol && bun run test
```

Expected: all tests pass (existing + new).

- [ ] **Step 7: Commit**

```bash
git add shared/protocol/src/sessions.ts \
        shared/protocol/src/sessions.test.ts \
        shared/protocol/src/messages.ts \
        shared/protocol/src/index.ts
git commit -m "$(cat <<'EOF'
feat(protocol): add sessions list/search/resume frames + SessionRow

Defines the wire contract for the past-sessions feature: SessionRow
shape, request/result frames for list/search/delete/rename/new/switch,
and the broadcast events (created/switched/deleted/renamed/error).
All title input bounded to 200 chars and stripped of control
characters at parse time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — ConversationMirror.replaceAll + onSnapshot

### Task 3.1: Add atomic replace + snapshot event

**Files:**
- Modify: `gateway/src/cerebrum/conversation-mirror.ts`
- Modify: `gateway/src/cerebrum/conversation-mirror.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `gateway/src/cerebrum/conversation-mirror.test.ts`. Append:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createConversationMirror, type MirrorEntry } from "./conversation-mirror.ts";

describe("ConversationMirror.replaceAll", () => {
  it("emits onSnapshot exactly once and never onAppend", () => {
    const mirror = createConversationMirror(500);
    const onAppend = vi.fn();
    const onSnapshot = vi.fn();
    mirror.onAppend(onAppend);
    mirror.onSnapshot(onSnapshot);

    const entries: MirrorEntry[] = [
      { kind: "user", ts: 1, channel: "text", content: "hi" },
      { kind: "assistant", ts: 2, content: "hello" },
      { kind: "user", ts: 3, channel: "text", content: "how" },
    ];
    mirror.replaceAll(entries);

    expect(onAppend).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(entries);
  });

  it("trims to capacity, keeping the tail", () => {
    const mirror = createConversationMirror(2);
    mirror.replaceAll([
      { kind: "user", ts: 1, channel: "text", content: "a" },
      { kind: "user", ts: 2, channel: "text", content: "b" },
      { kind: "user", ts: 3, channel: "text", content: "c" },
    ]);
    expect(mirror.size()).toBe(2);
    expect(mirror.snapshot().map((e) => (e.kind === "user" ? e.content : ""))).toEqual(["b", "c"]);
  });

  it("after replaceAll, subsequent append still emits onAppend", () => {
    const mirror = createConversationMirror(500);
    const onAppend = vi.fn();
    mirror.onAppend(onAppend);
    mirror.replaceAll([{ kind: "user", ts: 1, channel: "text", content: "seeded" }]);
    mirror.append({ kind: "user", ts: 2, channel: "text", content: "new" });
    expect(onAppend).toHaveBeenCalledTimes(1);
  });

  it("replaceAll with empty array clears the buffer and emits empty snapshot", () => {
    const mirror = createConversationMirror(500);
    mirror.append({ kind: "user", ts: 1, channel: "text", content: "x" });
    const onSnapshot = vi.fn();
    mirror.onSnapshot(onSnapshot);
    mirror.replaceAll([]);
    expect(mirror.size()).toBe(0);
    expect(onSnapshot).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd gateway && bun run test src/cerebrum/conversation-mirror.test.ts
```

Expected: FAIL — `mirror.replaceAll is not a function` (or similar).

- [ ] **Step 3: Implement replaceAll + onSnapshot**

Edit `gateway/src/cerebrum/conversation-mirror.ts`. Add to the `ConversationMirror` interface:

```typescript
export interface ConversationMirror {
  /** Append an entry. Oldest entries are evicted when over capacity. */
  append(entry: MirrorEntry): void;
  /** Return a snapshot of current entries (copy). */
  snapshot(): readonly MirrorEntry[];
  /** Remove all entries. */
  clear(): void;
  /** Current number of entries. */
  size(): number;
  /** Subscribe to per-entry append events. Returns unsubscribe. */
  onAppend(listener: (entry: MirrorEntry) => void): () => void;
  /**
   * Atomically replace the entire buffer. Honors capacity (keeps tail).
   * Fires onSnapshot listeners exactly once. Does NOT fire onAppend.
   */
  replaceAll(entries: readonly MirrorEntry[]): void;
  /** Subscribe to bulk-replace events. Returns unsubscribe. */
  onSnapshot(listener: (entries: readonly MirrorEntry[]) => void): () => void;
}
```

Update `createConversationMirror` body:

```typescript
export function createConversationMirror(capacity: number = DEFAULT_CAPACITY): ConversationMirror {
  const buffer: MirrorEntry[] = [];
  const appendListeners = new Set<(entry: MirrorEntry) => void>();
  const snapshotListeners = new Set<(entries: readonly MirrorEntry[]) => void>();

  return {
    append(entry) {
      log.debug("append", { kind: entry.kind, size: buffer.length });
      buffer.push(entry);
      if (buffer.length > capacity) {
        const dropped = buffer.length - capacity;
        buffer.splice(0, dropped);
        log.info("capacity-evict", { dropped, capacity, newSize: buffer.length });
      }
      for (const l of appendListeners) {
        try {
          l(entry);
        } catch {
          /* listener errors are non-fatal */
        }
      }
    },
    snapshot() {
      return [...buffer];
    },
    clear() {
      log.debug("clear", { previousSize: buffer.length });
      buffer.length = 0;
    },
    size() {
      return buffer.length;
    },
    onAppend(listener) {
      appendListeners.add(listener);
      return () => {
        appendListeners.delete(listener);
      };
    },
    replaceAll(entries) {
      const tail = entries.length > capacity ? entries.slice(entries.length - capacity) : [...entries];
      log.info("replaceAll", { previousSize: buffer.length, newSize: tail.length, capacity });
      buffer.length = 0;
      for (const e of tail) buffer.push(e);
      const view = [...buffer];
      for (const l of snapshotListeners) {
        try {
          l(view);
        } catch {
          /* listener errors are non-fatal */
        }
      }
    },
    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd gateway && bun run test src/cerebrum/conversation-mirror.test.ts
```

Expected: all four new tests PASS plus existing ones.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/conversation-mirror.ts \
        gateway/src/cerebrum/conversation-mirror.test.ts
git commit -m "$(cat <<'EOF'
feat(cerebrum/mirror): add replaceAll + onSnapshot for resume

Adds an atomic replace operation with a separate onSnapshot event
surface so consumers (presence wiring, attention gate) can distinguish
"new stimulus" (onAppend) from "history reconstruction" (onSnapshot)
and avoid 50x wake events during resume rehydration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — HermesSessionsClient (HTTP)

### Task 4.1: HTTP client for /api/sessions/*

**Files:**
- Create: `gateway/src/hermes-adapter-client/sessions-client.ts`
- Create: `gateway/src/hermes-adapter-client/sessions-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/hermes-adapter-client/sessions-client.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHermesSessionsClient } from "./sessions-client.ts";

// Lightweight in-process Bun.serve fake to assert wire shape — no real Hermes.
let server: ReturnType<typeof Bun.serve> | null = null;
let lastUrl = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      lastUrl = new URL(req.url).pathname + new URL(req.url).search;
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/api/sessions") {
        return Response.json({
          sessions: [
            {
              id: "s1",
              title: "Hello world",
              source: "sentient-user",
              started_at: 1_700_000_000,
              last_active: 1_700_000_500,
              ended_at: null,
              message_count: 4,
              preview: "what's the weather",
              is_active: false,
              parent_session_id: null,
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        });
      }
      if (req.method === "GET" && path === "/api/sessions/search") {
        return Response.json({ results: [] });
      }
      if (req.method === "GET" && path.startsWith("/api/sessions/") && path.endsWith("/messages")) {
        return Response.json({
          session_id: "s1",
          messages: [
            { role: "user", ts: 1_700_000_000, content: "hi" },
            { role: "assistant", ts: 1_700_000_001, content: "hello" },
          ],
        });
      }
      if (req.method === "GET" && path.startsWith("/api/sessions/")) {
        const id = path.replace("/api/sessions/", "");
        if (id === "does-not-exist") return new Response("not found", { status: 404 });
        return Response.json({
          id,
          title: `t-${id}`,
          source: "sentient-user",
          started_at: 1_700_000_000,
          last_active: 1_700_000_500,
          ended_at: null,
          message_count: 4,
          preview: "p",
          is_active: false,
          parent_session_id: null,
        });
      }
      if (req.method === "DELETE" && path.startsWith("/api/sessions/")) {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

const baseUrl = () => `http://127.0.0.1:${server!.port}`;

describe("HermesSessionsClient", () => {
  it("list passes ?source=sentient-user and limit/offset", async () => {
    const c = createHermesSessionsClient({ baseUrl: baseUrl(), source: "sentient-user", timeoutMs: 5000 });
    const rows = await c.list({ limit: 20, offset: 0 });
    expect(lastUrl).toBe("/api/sessions?limit=20&offset=0&source=sentient-user");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("s1");
  });

  it("get returns null on 404 and the row otherwise", async () => {
    const c = createHermesSessionsClient({ baseUrl: baseUrl(), source: "sentient-user", timeoutMs: 5000 });
    expect(await c.get("does-not-exist")).toBeNull();
    const row = await c.get("s1");
    expect(row?.id).toBe("s1");
    expect(row?.source).toBe("sentient-user");
  });

  it("getMessages returns the messages array", async () => {
    const c = createHermesSessionsClient({ baseUrl: baseUrl(), source: "sentient-user", timeoutMs: 5000 });
    const msgs = await c.getMessages("s1");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "user", content: "hi" });
  });

  it("delete returns void on 200", async () => {
    const c = createHermesSessionsClient({ baseUrl: baseUrl(), source: "sentient-user", timeoutMs: 5000 });
    await expect(c.delete("s1")).resolves.toBeUndefined();
  });

  it("404 throws a typed error with status", async () => {
    const c = createHermesSessionsClient({ baseUrl: baseUrl(), source: "sentient-user", timeoutMs: 5000 });
    await expect(c.getMessages("does-not-exist")).rejects.toMatchObject({ status: 404 });
  });

  it("timeout aborts the request", async () => {
    // Stand up a slow endpoint that never responds within timeout.
    const slow = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 1000));
        return Response.json({});
      },
    });
    try {
      const c = createHermesSessionsClient({ baseUrl: `http://127.0.0.1:${slow.port}`, source: "sentient-user", timeoutMs: 50 });
      await expect(c.list({ limit: 1, offset: 0 })).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      slow.stop(true);
    }
  });
});
```

NOTE: The fake-route logic above mirrors the actual Hermes upstream shapes you confirmed during the brainstorm. If you need to verify a shape, run:

```bash
docker exec <hermes-container-name> python -c \
  "import json; from hermes_state import SessionDB; print(json.dumps(SessionDB().list_sessions_rich(limit=1)))"
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd gateway && bun run test src/hermes-adapter-client/sessions-client.test.ts
```

Expected: FAIL — `./sessions-client.ts` not found.

- [ ] **Step 3: Implement the client**

Create `gateway/src/hermes-adapter-client/sessions-client.ts`:

```typescript
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "sessions", "client"]);

// Raw shapes returned by Hermes' /api/sessions/* — match upstream JSON keys.
export interface HermesSessionRow {
  id: string;
  title: string | null;
  source: string;
  started_at: number;
  last_active: number;
  ended_at: number | null;
  message_count: number;
  preview: string;
  is_active: boolean;
  parent_session_id: string | null;
}

export interface HermesSearchHit {
  session_id: string;
  snippet: string;
  role: string | null;
  source: string | null;
  model: string | null;
  session_started: number | null;
}

export type HermesRawMessageRole = "user" | "assistant" | "tool" | "tool_call" | "tool_result" | "system";

export interface HermesRawMessage {
  role: HermesRawMessageRole;
  ts: number;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
  // Hermes adds extras; passthrough.
  [k: string]: unknown;
}

export class HermesHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HermesHttpError";
    this.status = status;
  }
}

export interface HermesSessionsClient {
  list(opts: { limit: number; offset: number }): Promise<HermesSessionRow[]>;
  search(q: string, limit: number): Promise<HermesSearchHit[]>;
  get(sessionId: string): Promise<HermesSessionRow | null>;
  getMessages(sessionId: string): Promise<HermesRawMessage[]>;
  delete(sessionId: string): Promise<void>;
}

export interface HermesSessionsClientConfig {
  /** Base URL of the per-profile Hermes web_server, e.g. http://hermes-u_abc:8765 */
  readonly baseUrl: string;
  /** Source filter applied to every list call. */
  readonly source: string;
  /** Per-request timeout in ms. */
  readonly timeoutMs: number;
}

export function createHermesSessionsClient(cfg: HermesSessionsClientConfig): HermesSessionsClient {
  const fetchWithTimeout = async (path: string, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, { ...init, signal: controller.signal });
      return res;
    } finally {
      clearTimeout(t);
    }
  };

  return {
    async list({ limit, offset }) {
      const url = `/api/sessions?limit=${limit}&offset=${offset}&source=${encodeURIComponent(cfg.source)}`;
      log.debug("list:request", { url });
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        log.warn("list:non-ok", { status: res.status });
        throw new HermesHttpError(res.status, `GET ${url} -> ${res.status}`);
      }
      const body = (await res.json()) as { sessions?: HermesSessionRow[] };
      const rows = body.sessions ?? [];
      log.info("list:ok", { count: rows.length, source: cfg.source });
      return rows;
    },

    async search(q, limit) {
      const url = `/api/sessions/search?q=${encodeURIComponent(q)}&limit=${limit}`;
      log.debug("search:request", { url, q_len: q.length });
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        log.warn("search:non-ok", { status: res.status });
        throw new HermesHttpError(res.status, `GET ${url} -> ${res.status}`);
      }
      const body = (await res.json()) as { results?: HermesSearchHit[] };
      const hits = body.results ?? [];
      log.info("search:ok", { hits: hits.length });
      return hits;
    },

    async get(sessionId) {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}`;
      log.debug("get:request", { url, sessionId });
      const res = await fetchWithTimeout(url);
      if (res.status === 404) return null;
      if (!res.ok) {
        log.warn("get:non-ok", { status: res.status, sessionId });
        throw new HermesHttpError(res.status, `GET ${url} -> ${res.status}`);
      }
      const row = (await res.json()) as HermesSessionRow;
      log.info("get:ok", { sessionId });
      return row;
    },

    async getMessages(sessionId) {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages`;
      log.debug("getMessages:request", { url, sessionId });
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        log.warn("getMessages:non-ok", { status: res.status, sessionId });
        throw new HermesHttpError(res.status, `GET ${url} -> ${res.status}`);
      }
      const body = (await res.json()) as { messages?: HermesRawMessage[] };
      const msgs = body.messages ?? [];
      log.info("getMessages:ok", { sessionId, count: msgs.length });
      return msgs;
    },

    async delete(sessionId) {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}`;
      log.debug("delete:request", { url, sessionId });
      const res = await fetchWithTimeout(url, { method: "DELETE" });
      if (!res.ok) {
        log.warn("delete:non-ok", { status: res.status, sessionId });
        throw new HermesHttpError(res.status, `DELETE ${url} -> ${res.status}`);
      }
      log.info("delete:ok", { sessionId });
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
cd gateway && bun run test src/hermes-adapter-client/sessions-client.test.ts
```

Expected: all 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/hermes-adapter-client/sessions-client.ts \
        gateway/src/hermes-adapter-client/sessions-client.test.ts
git commit -m "$(cat <<'EOF'
feat(gateway): HermesSessionsClient HTTP client for /api/sessions

Wraps Hermes' upstream HTTP API with timeout-bounded list / search /
get-messages / delete. Source filter is config-driven (sentient-user)
and applied on every list call. 4xx/5xx surface as typed
HermesHttpError; AbortError on timeout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Title-override store

### Task 5.1: Per-profile JSON title-override store

**Files:**
- Create: `gateway/src/sessions/title-store.ts`
- Create: `gateway/src/sessions/title-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/sessions/title-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTitleStore } from "./title-store.ts";

describe("TitleStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "title-store-"));
  });

  it("returns undefined for a missing override", async () => {
    const s = createTitleStore({ rootDir: dir, userId: "u1" });
    expect(await s.getTitle("missing")).toBeUndefined();
  });

  it("setTitle persists, getTitle reads it back", async () => {
    const s = createTitleStore({ rootDir: dir, userId: "u1" });
    await s.setTitle("s1", "My chat");
    expect(await s.getTitle("s1")).toBe("My chat");
    const onDisk = JSON.parse(await readFile(join(dir, "u1.json"), "utf8"));
    expect(onDisk.s1).toBe("My chat");
  });

  it("getTitlesFor returns map for known ids only", async () => {
    const s = createTitleStore({ rootDir: dir, userId: "u1" });
    await s.setTitle("a", "A");
    await s.setTitle("b", "B");
    const map = await s.getTitlesFor(["a", "b", "c"]);
    expect(map).toEqual({ a: "A", b: "B" });
  });

  it("delete removes the override", async () => {
    const s = createTitleStore({ rootDir: dir, userId: "u1" });
    await s.setTitle("s1", "Hi");
    await s.delete("s1");
    expect(await s.getTitle("s1")).toBeUndefined();
  });

  it("corrupt JSON falls back to empty map and logs WARN", async () => {
    await writeFile(join(dir, "u1.json"), "this is not json", "utf8");
    const s = createTitleStore({ rootDir: dir, userId: "u1" });
    expect(await s.getTitle("anything")).toBeUndefined();
    // Subsequent setTitle should rebuild the file.
    await s.setTitle("s1", "ok");
    expect(await s.getTitle("s1")).toBe("ok");
  });

  it("file mode is 0600 after write", async () => {
    const s = createTitleStore({ rootDir: dir, userId: "u1" });
    await s.setTitle("s1", "Hi");
    const st = await stat(join(dir, "u1.json"));
    // Lower 9 bits == permission mask. 0o600 == 0o600 user read+write only.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("rejects user ids that contain path separators", async () => {
    const s = createTitleStore({ rootDir: dir, userId: "../escape" });
    await expect(s.setTitle("s1", "x")).rejects.toThrow(/invalid userId/i);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd gateway && bun run test src/sessions/title-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `gateway/src/sessions/title-store.ts`:

```typescript
import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "sessions", "title-store"]);

export interface TitleStore {
  getTitle(sessionId: string): Promise<string | undefined>;
  getTitlesFor(sessionIds: readonly string[]): Promise<Record<string, string>>;
  setTitle(sessionId: string, title: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface TitleStoreConfig {
  /** Directory under which `<userId>.json` lives. */
  readonly rootDir: string;
  /** Profile id this store binds to. Validated to prevent path traversal. */
  readonly userId: string;
}

const USERID_RE = /^[A-Za-z0-9_-]+$/;

export function createTitleStore(cfg: TitleStoreConfig): TitleStore {
  if (!USERID_RE.test(cfg.userId)) {
    throw new Error(`invalid userId: ${cfg.userId}`);
  }
  const filePath = join(cfg.rootDir, `${cfg.userId}.json`);

  let cache: Record<string, string> | null = null;

  const load = async (): Promise<Record<string, string>> => {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        log.warn("malformed-shape", { filePath });
        cache = {};
      } else {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v;
        }
        cache = out;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        cache = {};
      } else {
        log.warn("read-failed", { filePath, code });
        cache = {};
      }
    }
    return cache;
  };

  const persist = async (): Promise<void> => {
    if (!cache) return;
    await mkdir(cfg.rootDir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
    // Bun's writeFile honors mode at create; chmod is a belt-and-suspenders step
    // for systems where the mode arg gets masked away.
    await chmod(tmp, 0o600);
    // Atomic rename — readers either see the old content or the new, never partial.
    const { rename } = await import("node:fs/promises");
    await rename(tmp, filePath);
  };

  return {
    async getTitle(sessionId) {
      const c = await load();
      return c[sessionId];
    },
    async getTitlesFor(ids) {
      const c = await load();
      const out: Record<string, string> = {};
      for (const id of ids) if (c[id] !== undefined) out[id] = c[id];
      return out;
    },
    async setTitle(sessionId, title) {
      const c = await load();
      c[sessionId] = title;
      log.info("setTitle", { sessionId, len: title.length });
      await persist();
    },
    async delete(sessionId) {
      const c = await load();
      if (c[sessionId] !== undefined) {
        delete c[sessionId];
        log.info("delete", { sessionId });
        if (Object.keys(c).length === 0) {
          // Empty file is fine; keep on disk for atomicity simplicity.
          await persist();
          return;
        }
        await persist();
      }
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
cd gateway && bun run test src/sessions/title-store.test.ts
```

Expected: all 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/sessions/title-store.ts \
        gateway/src/sessions/title-store.test.ts
git commit -m "$(cat <<'EOF'
feat(sessions): per-profile title-override store

Tiny JSON store at ~/.sentient/gateway/session-titles/<userId>.json
that lets the gateway override Hermes auto-generated titles without
patching upstream. Mode 0600, atomic write via tmp+rename, corrupt
JSON falls back to empty without throwing. Path traversal blocked
via userId regex.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Switch-flow state machine

### Task 6.1: switch-flow.ts (states + transitions)

**Files:**
- Create: `gateway/src/sessions/switch-flow.ts`
- Create: `gateway/src/sessions/switch-flow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/sessions/switch-flow.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createSwitchFlow, type SwitchFlowState } from "./switch-flow.ts";

const noopMirror = {
  replaceAll: vi.fn(),
} as const;

describe("SwitchFlow", () => {
  it("starts in idle", () => {
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: () => Promise.resolve(),
      fetchHistory: async () => [],
      teardownTimeoutMs: 1000,
    });
    expect(f.state).toBe<SwitchFlowState>("idle");
  });

  it("happy path: idle -> cancelling -> fetching -> rehydrating -> ready", async () => {
    const seen: SwitchFlowState[] = [];
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: async () => {
        seen.push(f.state);
      },
      fetchHistory: async () => {
        seen.push(f.state);
        return [];
      },
      teardownTimeoutMs: 1000,
    });
    await f.switchTo("s1");
    expect(seen).toEqual(["cancelling", "fetching"]);
    expect(f.state).toBe<SwitchFlowState>("ready");
  });

  it("rejects user.message while not idle/ready", async () => {
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: () => new Promise((r) => setTimeout(r, 100)),
      fetchHistory: async () => [],
      teardownTimeoutMs: 1000,
    });
    const inFlight = f.switchTo("s1");
    expect(f.canAcceptUserMessage()).toBe(false);
    await inFlight;
    expect(f.canAcceptUserMessage()).toBe(true);
  });

  it("concurrent switches: latest wins, prior is aborted", async () => {
    const fetched: string[] = [];
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: async () => {},
      fetchHistory: async (id, signal) => {
        await new Promise((r) => setTimeout(r, 50));
        if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        fetched.push(id);
        return [];
      },
      teardownTimeoutMs: 1000,
    });
    const a = f.switchTo("first");
    const b = f.switchTo("second");
    await Promise.allSettled([a, b]);
    expect(fetched).toEqual(["second"]);
  });

  it("teardown timeout: aborts wait, proceeds to fetch", async () => {
    const f = createSwitchFlow({
      mirror: noopMirror,
      cancelCurrentCycle: () => new Promise(() => { /* never resolves */ }),
      fetchHistory: async () => [],
      teardownTimeoutMs: 30,
    });
    await f.switchTo("s1");
    expect(f.state).toBe<SwitchFlowState>("ready");
  });

  it("calls mirror.replaceAll with fetched entries", async () => {
    const replaceAll = vi.fn();
    const f = createSwitchFlow({
      mirror: { replaceAll },
      cancelCurrentCycle: async () => {},
      fetchHistory: async () => [{ kind: "user", ts: 1, channel: "text", content: "hi" }],
      teardownTimeoutMs: 1000,
    });
    await f.switchTo("s1");
    expect(replaceAll).toHaveBeenCalledOnce();
    expect(replaceAll.mock.calls[0][0]).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd gateway && bun run test src/sessions/switch-flow.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `gateway/src/sessions/switch-flow.ts`:

```typescript
import { getLog } from "../logging/logger.js";
import type { MirrorEntry } from "../cerebrum/conversation-mirror.ts";

const log = getLog(["sentient", "sessions", "switch"]);

export type SwitchFlowState = "idle" | "cancelling" | "fetching" | "rehydrating" | "ready";

export interface SwitchFlowMirror {
  replaceAll(entries: readonly MirrorEntry[]): void;
}

export interface SwitchFlowConfig {
  readonly mirror: SwitchFlowMirror;
  /** Aborts the active cycle (interruptController). Should resolve when the cycle has truly torn down. */
  readonly cancelCurrentCycle: () => Promise<void>;
  /** Pulls history for the target sessionId. Honors AbortSignal for concurrent-switch cancellation. */
  readonly fetchHistory: (sessionId: string, signal: AbortSignal) => Promise<readonly MirrorEntry[]>;
  /** Hard cap on cancelCurrentCycle wait. */
  readonly teardownTimeoutMs: number;
}

export interface SwitchFlow {
  readonly state: SwitchFlowState;
  /** True iff state is idle or ready. */
  canAcceptUserMessage(): boolean;
  /** Run the switch state machine for the given target. */
  switchTo(sessionId: string): Promise<void>;
}

export function createSwitchFlow(cfg: SwitchFlowConfig): SwitchFlow {
  let state: SwitchFlowState = "idle";
  let active: { id: string; abort: AbortController } | null = null;

  const transition = (next: SwitchFlowState): void => {
    log.debug("transition", { from: state, to: next });
    state = next;
  };

  const withTimeout = async (p: Promise<void>, ms: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("teardown-timeout", { ms });
        resolve();
      }, ms);
    });
    try {
      await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    get state() {
      return state;
    },
    canAcceptUserMessage(): boolean {
      return state === "idle" || state === "ready";
    },
    async switchTo(sessionId: string): Promise<void> {
      // Abort any in-flight switch — latest wins.
      if (active) {
        log.info("switch:supersede", { from: active.id, to: sessionId });
        active.abort.abort();
      }
      const abort = new AbortController();
      active = { id: sessionId, abort };

      try {
        transition("cancelling");
        await withTimeout(cfg.cancelCurrentCycle(), cfg.teardownTimeoutMs);
        if (abort.signal.aborted) return;

        transition("fetching");
        const entries = await cfg.fetchHistory(sessionId, abort.signal);
        if (abort.signal.aborted) return;

        transition("rehydrating");
        cfg.mirror.replaceAll(entries);
        if (abort.signal.aborted) return;

        transition("ready");
      } catch (err: unknown) {
        const name = (err as { name?: string }).name;
        if (name === "AbortError") {
          log.info("switch:aborted", { sessionId });
          return;
        }
        log.warn("switch:error", { sessionId, message: (err as Error).message });
        transition("idle");
        throw err;
      } finally {
        if (active && active.id === sessionId) active = null;
      }
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
cd gateway && bun run test src/sessions/switch-flow.test.ts
```

Expected: all 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/sessions/switch-flow.ts \
        gateway/src/sessions/switch-flow.test.ts
git commit -m "$(cat <<'EOF'
feat(sessions): switch-flow state machine

States: idle -> cancelling -> fetching -> rehydrating -> ready.
Concurrent switches: latest wins via AbortController. teardownTimeoutMs
caps the cycle-cancel wait so a stuck cycle can't block resume forever.
canAcceptUserMessage() gates inbound user.message frames during the
window.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7 — Sessions WS handlers (gateway side)

### Task 7.1: WS frame router for sessions.* and session.new/switch

**Files:**
- Create: `gateway/src/session-handlers/sessions-handlers.ts`
- Create: `gateway/src/session-handlers/sessions-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/session-handlers/sessions-handlers.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createSessionsHandlers } from "./sessions-handlers.ts";
import type { HermesSessionsClient, HermesSessionRow } from "../hermes-adapter-client/sessions-client.ts";

const row = (id: string, source = "sentient-user"): HermesSessionRow => ({
  id,
  title: `t-${id}`,
  source,
  started_at: 1_000,
  last_active: 2_000,
  ended_at: null,
  message_count: 1,
  preview: "p",
  is_active: false,
  parent_session_id: null,
});

describe("SessionsHandlers", () => {
  it("list — returns rows mapped to SessionRow with title overrides applied", async () => {
    const send = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      client: {
        list: async () => [row("a"), row("b")],
        search: async () => [],
        getMessages: async () => [],
        delete: async () => {},
      } as HermesSessionsClient,
      titleStore: {
        getTitle: async () => undefined,
        getTitlesFor: async () => ({ a: "Override A" }),
        setTitle: async () => {},
        delete: async () => {},
      },
      send,
      switchFlow: { state: "idle", canAcceptUserMessage: () => true, switchTo: async () => {} },
      profileSessionsLookup: async () => new Set(["a", "b"]),
    });
    await h.handle({ type: "sessions.list", requestId: "r1", limit: 20, offset: 0 });
    expect(send).toHaveBeenCalledOnce();
    const sent = send.mock.calls[0][0];
    expect(sent.type).toBe("sessions.list.result");
    expect(sent.items[0]).toMatchObject({ sessionId: "a", title: "Override A" });
    expect(sent.items[1]).toMatchObject({ sessionId: "b", title: "t-b" });
  });

  it("delete — cross-profile sessionId rejected with forbidden", async () => {
    const send = vi.fn();
    const del = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      client: {
        list: async () => [],
        search: async () => [],
        getMessages: async () => [],
        delete: del,
      } as HermesSessionsClient,
      titleStore: {
        getTitle: async () => undefined,
        getTitlesFor: async () => ({}),
        setTitle: async () => {},
        delete: async () => {},
      },
      send,
      switchFlow: { state: "idle", canAcceptUserMessage: () => true, switchTo: async () => {} },
      profileSessionsLookup: async () => new Set(["a", "b"]),
    });
    await h.handle({ type: "sessions.delete", requestId: "r1", sessionId: "z" });
    expect(del).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0]).toMatchObject({
      type: "sessions.error",
      requestId: "r1",
      code: "forbidden",
    });
  });

  it("rename — writes to title store and broadcasts", async () => {
    const setTitle = vi.fn(async () => {});
    const send = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      client: {
        list: async () => [],
        search: async () => [],
        getMessages: async () => [],
        delete: async () => {},
      } as HermesSessionsClient,
      titleStore: {
        getTitle: async () => undefined,
        getTitlesFor: async () => ({}),
        setTitle,
        delete: async () => {},
      },
      send,
      switchFlow: { state: "idle", canAcceptUserMessage: () => true, switchTo: async () => {} },
      profileSessionsLookup: async () => new Set(["a"]),
    });
    await h.handle({ type: "sessions.rename", requestId: "r1", sessionId: "a", title: "Renamed" });
    expect(setTitle).toHaveBeenCalledWith("a", "Renamed");
    const broadcast = send.mock.calls.find((c) => c[0].type === "sessions.renamed");
    expect(broadcast).toBeTruthy();
    expect(broadcast![0]).toMatchObject({ sessionId: "a", title: "Renamed" });
  });

  it("switch — guarded by ownership; calls switchFlow.switchTo on success", async () => {
    const switchTo = vi.fn(async () => {});
    const send = vi.fn();
    const h = createSessionsHandlers({
      userId: "u1",
      client: {
        list: async () => [],
        search: async () => [],
        getMessages: async () => [],
        delete: async () => {},
      } as HermesSessionsClient,
      titleStore: {
        getTitle: async () => undefined,
        getTitlesFor: async () => ({}),
        setTitle: async () => {},
        delete: async () => {},
      },
      send,
      switchFlow: { state: "idle", canAcceptUserMessage: () => true, switchTo },
      profileSessionsLookup: async () => new Set(["a", "b"]),
    });
    await h.handle({ type: "session.switch", requestId: "r1", sessionId: "a" });
    expect(switchTo).toHaveBeenCalledWith("a");
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd gateway && bun run test src/session-handlers/sessions-handlers.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `gateway/src/session-handlers/sessions-handlers.ts`:

```typescript
import { getLog } from "../logging/logger.js";
import type { SessionRow } from "@sentient/protocol";
import type { HermesSessionsClient, HermesSessionRow } from "../hermes-adapter-client/sessions-client.ts";
import type { TitleStore } from "../sessions/title-store.ts";
import type { SwitchFlow } from "../sessions/switch-flow.ts";

const log = getLog(["sentient", "sessions", "ws"]);

export interface SessionsHandlersConfig {
  readonly userId: string;
  readonly client: HermesSessionsClient;
  readonly titleStore: TitleStore;
  readonly send: (frame: Record<string, unknown>) => void;
  readonly switchFlow: SwitchFlow;
  /** Returns the set of session ids owned by the current profile (for ownership guard). */
  readonly profileSessionsLookup: () => Promise<Set<string>>;
}

type Inbound =
  | { type: "sessions.list"; requestId: string; limit: number; offset: number }
  | { type: "sessions.search"; requestId: string; q: string; limit: number }
  | { type: "sessions.delete"; requestId: string; sessionId: string }
  | { type: "sessions.rename"; requestId: string; sessionId: string; title: string }
  | { type: "session.new"; requestId: string }
  | { type: "session.switch"; requestId: string; sessionId: string };

export interface SessionsHandlers {
  handle(frame: Inbound): Promise<void>;
}

const toSessionRow = (raw: HermesSessionRow, override: string | undefined): SessionRow => ({
  sessionId: raw.id,
  rootId: raw.parent_session_id ?? raw.id,
  title: override ?? raw.title ?? "New chat",
  startedAt: Math.round(raw.started_at * 1000),
  lastActiveAt: Math.round((raw.last_active ?? raw.started_at) * 1000),
  messageCount: raw.message_count,
  preview: raw.preview,
  isActive: raw.is_active,
});

export function createSessionsHandlers(cfg: SessionsHandlersConfig): SessionsHandlers {
  const sendError = (requestId: string, code: "forbidden" | "not_found" | "internal" | "validation", message: string): void => {
    cfg.send({ type: "sessions.error", requestId, code, message });
  };

  const enforceOwnership = async (sessionId: string, requestId: string): Promise<boolean> => {
    const owned = await cfg.profileSessionsLookup();
    if (!owned.has(sessionId)) {
      log.warn("ownership-reject", { userId: cfg.userId, sessionId });
      sendError(requestId, "forbidden", "session not owned by current profile");
      return false;
    }
    return true;
  };

  return {
    async handle(frame) {
      try {
        switch (frame.type) {
          case "sessions.list": {
            const rows = await cfg.client.list({ limit: frame.limit, offset: frame.offset });
            const ids = rows.map((r) => r.id);
            const overrides = await cfg.titleStore.getTitlesFor(ids);
            // Defense-in-depth: filter to source=sentient-user even if the HTTP layer didn't.
            const filtered = rows.filter((r) => r.source === "sentient-user");
            const items = filtered.map((r) => toSessionRow(r, overrides[r.id]));
            cfg.send({
              type: "sessions.list.result",
              requestId: frame.requestId,
              items,
              total: items.length,
              hasMore: items.length === frame.limit,
            });
            log.info("list:done", { count: items.length, requestId: frame.requestId });
            return;
          }
          case "sessions.search": {
            const hits = await cfg.client.search(frame.q, frame.limit);
            const ids = hits.map((h) => h.session_id);
            const owned = await cfg.profileSessionsLookup();
            const visible = hits.filter((h) => owned.has(h.session_id));
            const overrides = await cfg.titleStore.getTitlesFor(visible.map((h) => h.session_id));
            // Hits don't carry full row data — fetch each row individually via /api/sessions/{id}.
            // Capped by search_max_results (default 20), so the N+1 is bounded and acceptable.
            const items: SessionRow[] = [];
            for (const h of visible) {
              try {
                const row = await cfg.client.get(h.session_id);
                if (row && row.source === "sentient-user") {
                  items.push(toSessionRow(row, overrides[h.session_id]));
                }
              } catch {
                /* ignore single hit fetch error; soldier on */
              }
            }
            cfg.send({ type: "sessions.search.result", requestId: frame.requestId, items });
            log.info("search:done", { hits: hits.length, returned: items.length, requestId: frame.requestId });
            return;
          }
          case "sessions.delete": {
            if (!(await enforceOwnership(frame.sessionId, frame.requestId))) return;
            try {
              await cfg.client.delete(frame.sessionId);
              await cfg.titleStore.delete(frame.sessionId);
              cfg.send({ type: "sessions.deleted", sessionId: frame.sessionId });
              log.info("delete:done", { sessionId: frame.sessionId });
            } catch (err: unknown) {
              const status = (err as { status?: number }).status;
              if (status === 404) {
                sendError(frame.requestId, "not_found", "session not found");
                return;
              }
              throw err;
            }
            return;
          }
          case "sessions.rename": {
            if (!(await enforceOwnership(frame.sessionId, frame.requestId))) return;
            await cfg.titleStore.setTitle(frame.sessionId, frame.title);
            cfg.send({ type: "sessions.renamed", sessionId: frame.sessionId, title: frame.title });
            log.info("rename:done", { sessionId: frame.sessionId });
            return;
          }
          case "session.new": {
            // Fresh chat: clear the mirror now (degenerate switch with empty target).
            // The actual session id is assigned by Hermes on the next user.message and arrives
            // back via the Hermes event translator as a real `session.created` frame — do NOT
            // emit a placeholder here; that would create a phantom row in the SDK list.
            await cfg.switchFlow.switchTo("");
            return;
          }
          case "session.switch": {
            if (!(await enforceOwnership(frame.sessionId, frame.requestId))) return;
            await cfg.switchFlow.switchTo(frame.sessionId);
            // session.switched emitted by the switch-flow wiring (ws-session-configure) once
            // mirror.replaceAll is done — see Phase 10.
            return;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("handler:error", { type: (frame as { type: string }).type, message });
        sendError((frame as { requestId: string }).requestId ?? "", "internal", message);
      }
    },
  };
}
```

NOTE on `session.new` / `session.switch` ack frames: the actual `session.created` / `session.switched` events are emitted by the wiring layer in Phase 10, not the handler. The handler invokes `switchFlow` and lets the wiring observe `mirror.onSnapshot` to fire the matching event after `replaceAll` lands. The placeholder `session.created` send here is a temporary scaffold — Phase 10 removes it and replaces it with proper emission post-`mirror.replaceAll([])`.

NOTE on search: the upstream `/api/sessions/search` returns lightweight hit objects, not full rows. The implementation above fetches list rows separately to enrich. A future optimization (out of v1 scope) is to add a richer `?with_rows=1` to the upstream search route — for now, accept the N+1 and cap `search_max_results` low.

- [ ] **Step 4: Run tests**

```bash
cd gateway && bun run test src/session-handlers/sessions-handlers.test.ts
```

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-handlers/sessions-handlers.ts \
        gateway/src/session-handlers/sessions-handlers.test.ts
git commit -m "$(cat <<'EOF'
feat(gateway): WS frame handlers for sessions.* + session.new/switch

Handles list / search / delete / rename / new / switch, with
defense-in-depth ownership guards (every sessionId checked against
profile) and source-tag double-check on list. Title overrides
applied via TitleStore. Switch routes to SwitchFlow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 8 — Hermes event translator additions

### Task 8.1: Translate session.created / session.switched events

**Files:**
- Modify: `gateway/src/hermes-adapter-client/event-translator.ts`
- Modify: `gateway/src/hermes-adapter-client/event-translator.test.ts`

- [ ] **Step 1: Read the existing translator**

```bash
sed -n '1,60p' gateway/src/hermes-adapter-client/event-translator.ts
```

Find the existing `translate` function (or equivalent dispatch pattern). Note its input shape (`HermesFrame`, etc.).

- [ ] **Step 2: Write the failing test**

Append to `gateway/src/hermes-adapter-client/event-translator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { translateHermesFrame } from "./event-translator.ts";

describe("translateHermesFrame — session events", () => {
  it("translates session.created", () => {
    const out = translateHermesFrame({
      type: "session.created",
      session_id: "s1",
      title: "Hello",
      ts: 1_700_000_000_000,
    });
    expect(out).toEqual([
      { type: "session.created", sessionId: "s1", title: "Hello", ts: 1_700_000_000_000 },
    ]);
  });

  it("translates session.switched", () => {
    const out = translateHermesFrame({
      type: "session.switched",
      session_id: "s2",
      title: "Other",
      ts: 1_700_000_001_000,
    });
    expect(out).toEqual([
      { type: "session.switched", sessionId: "s2", title: "Other", ts: 1_700_000_001_000 },
    ]);
  });
});
```

- [ ] **Step 3: Implement translator branches**

Open `gateway/src/hermes-adapter-client/event-translator.ts`. In the dispatch switch, add cases:

```typescript
case "session.created": {
  const f = frame as { session_id: string; title?: string; ts: number };
  return [{ type: "session.created", sessionId: f.session_id, title: f.title, ts: f.ts }];
}
case "session.switched": {
  const f = frame as { session_id: string; title?: string; ts: number };
  return [{ type: "session.switched", sessionId: f.session_id, title: f.title, ts: f.ts }];
}
```

If the existing translator uses a different idiom (e.g. typed branches in `ws-frames.ts`), follow that pattern instead.

- [ ] **Step 4: Run translator tests**

```bash
cd gateway && bun run test src/hermes-adapter-client/event-translator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/hermes-adapter-client/event-translator.ts \
        gateway/src/hermes-adapter-client/event-translator.test.ts
git commit -m "$(cat <<'EOF'
feat(gateway/translator): forward session.created / session.switched

Hermes-side events flow straight through to the SDK-facing WS frames
of the same name. Type bridge converts snake_case session_id to
camelCase sessionId per protocol contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 9 — Sentient overlay adapter wiring

### Task 9.1: Accept session_id on user.message; emit session.created/switched

**Files:**
- Modify: `deploy/hermes-overlay/sentient_gateway.py`

NOTE: this is Python in a separate runtime — no vitest path. Verification is via container rebuild + `@live` Playwright smoke later. We tighten by reading the file first and finding the existing user.message dispatch + active-session helpers.

- [ ] **Step 1: Read current adapter to locate the user.message handler and active-session API**

```bash
grep -nE "(user\.message|active_session|set_active|EntryState)" deploy/hermes-overlay/sentient_gateway.py | head -40
```

Note the exact symbol names for setting the active session. (Likely `gateway.session.set_active_session_id(profile, sid)` or similar — confirm by reading `gateway/session.py` inside the image.)

- [ ] **Step 2: Patch the adapter**

Open `deploy/hermes-overlay/sentient_gateway.py` and locate the inbound `user.message` dispatch. Add the optional `session_id` field handling. Pseudocode (adapt to exact local structure):

```python
async def _handle_user_message(self, profile, frame):
    raw_session_id = frame.get("session_id")
    if isinstance(raw_session_id, str) and raw_session_id.strip():
        target = raw_session_id.strip()
        # Force the active session before invoking the agent.
        from gateway.session import set_active_session_id  # exact import path varies
        set_active_session_id(profile, target)
        await self._emit_session_switched(profile, target)
    # ... existing dispatch unchanged.
```

Add helper emitters:

```python
async def _emit_session_created(self, profile, session_id, title=None):
    await self._send_to_gateway({
        "type": "session.created",
        "session_id": session_id,
        "title": title,
        "ts": int(time.time() * 1000),
    })

async def _emit_session_switched(self, profile, session_id, title=None):
    await self._send_to_gateway({
        "type": "session.switched",
        "session_id": session_id,
        "title": title,
        "ts": int(time.time() * 1000),
    })
```

Hook `_emit_session_created` into the path where Hermes assigns a brand-new session id (likely the `EntryState.session_id` mutation point). Hook `_emit_session_switched` whenever the active session changes — including Hermes-initiated rotations from compression.

ALSO: when the adapter sees a user.message land on a fresh chain (no parent session id, message_count=1 in DB), tag the row with `source='sentient-user'`. The existing adapter likely already writes a source — confirm and update if it differs.

- [ ] **Step 3: Rebuild image and start fresh**

```bash
docker build -t sentient/hermes:local deploy/hermes-overlay/
```

- [ ] **Step 4: Smoke via the existing Mac stack**

(Defer to Phase 16 — full Playwright smoke covers this end-to-end. For now, just confirm the image builds.)

- [ ] **Step 5: Commit**

```bash
git add deploy/hermes-overlay/sentient_gateway.py
git commit -m "$(cat <<'EOF'
feat(hermes-overlay): accept session_id on user.message + emit events

The sentient adapter now honors an optional session_id field on
inbound user.message, forcing Hermes' active session for the profile
before invoking the agent. Emits session.created on new chains and
session.switched on every active-session change (including Hermes-
initiated compression rotations). New chains tagged source=sentient-user.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 10 — Wire it together (ws-session-configure)

### Task 10.1: Per-profile HTTP base URL on the connection

**Files:**
- Modify: `gateway/src/hermes-adapter-client/per-profile-connection.ts`
- Modify: `gateway/src/hermes-adapter-client/per-profile-connection.test.ts`

- [ ] **Step 1: Add `httpBaseUrl` to the connection config**

Read `gateway/src/hermes-adapter-client/per-profile-connection.ts` and locate the existing config interface. Add:

```typescript
export interface PerProfileConnectionConfig {
  // ... existing fields
  /** HTTP base URL for the profile's Hermes web_server (e.g. http://hermes-u_abc:8765). */
  readonly httpBaseUrl: string;
}
```

Expose it on the resulting connection object so callers can reach it for sessions HTTP.

- [ ] **Step 2: Update existing tests for the new field**

Patch any constructors in `per-profile-connection.test.ts` that now need `httpBaseUrl`. Use `http://test-hermes` as a placeholder.

- [ ] **Step 3: Run tests**

```bash
cd gateway && bun run test src/hermes-adapter-client/per-profile-connection.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/hermes-adapter-client/per-profile-connection.ts \
        gateway/src/hermes-adapter-client/per-profile-connection.test.ts
git commit -m "$(cat <<'EOF'
feat(hermes-client): expose httpBaseUrl on PerProfileConnection

Allows downstream consumers (HermesSessionsClient) to reach the
profile's HTTP API alongside the existing WS transport.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 10.2: Wire SessionsConnector + SwitchFlow into ws-session-configure

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`
- Modify: `gateway/src/cerebrum/attention-gate.ts`

This is the integration task — read the file first, then edit. Each step is small.

- [ ] **Step 1: Read the existing handler to find the factory points**

```bash
grep -nE "(handleSessionConfigure|createConversationMirror|interruptController|conversationFeedUnsub)" gateway/src/session-handlers/ws-session-configure.ts | head
```

Locate where `createConversationMirror`, `interruptController`, and the user.message dispatcher are wired. Determine where to plug in the new pieces.

- [ ] **Step 2: Read connect-URL parsing point**

```bash
grep -nE "(URL\(|searchParams|session_id)" gateway/src/session-handlers/ws-session-configure.ts | head
```

If the handler doesn't currently parse query params from the WS upgrade URL, find where the upgrade is accepted (likely in `gateway/src/server.ts` or the WS-upgrade entry) and capture `?session_id=` there, threading it into `handleSessionConfigure` via the session config.

- [ ] **Step 3: Add the wiring**

Inside `handleSessionConfigure` (after the mirror is created), add:

```typescript
import { createHermesSessionsClient } from "../hermes-adapter-client/sessions-client.ts";
import { createTitleStore } from "../sessions/title-store.ts";
import { createSwitchFlow } from "../sessions/switch-flow.ts";
import { createSessionsHandlers } from "./sessions-handlers.ts";

// ... inside handleSessionConfigure, after `const mirror = createConversationMirror(...)`

const sessionsClient = createHermesSessionsClient({
  baseUrl: hermesBinding.httpBaseUrl,
  source: services.config.sessions.source_tag,
  timeoutMs: services.config.sessions.hermes_http_timeout_ms,
});
const titleStore = createTitleStore({
  rootDir: services.config.sessions.title_override_dir,
  userId,
});
const switchFlow = createSwitchFlow({
  mirror: { replaceAll: (entries) => mirror.replaceAll(entries) },
  cancelCurrentCycle: () => interruptController.abort(),
  fetchHistory: async (sessionId, signal) => {
    if (!sessionId) return []; // session.new: clear mirror only
    const raw = await sessionsClient.getMessages(sessionId);
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return raw
      .map((m) => hermesMessageToMirrorEntry(m))
      .filter((e): e is NonNullable<typeof e> => e !== null);
  },
  teardownTimeoutMs: services.config.sessions.switch_teardown_timeout_ms,
});
const profileSessionsLookup = async (): Promise<Set<string>> => {
  const rows = await sessionsClient.list({ limit: 100, offset: 0 });
  return new Set(rows.map((r) => r.id));
};

const sessionsHandlers = createSessionsHandlers({
  userId,
  client: sessionsClient,
  titleStore,
  send: (frame) => ws.send(JSON.stringify(frame)),
  switchFlow,
  profileSessionsLookup,
});

// Subscribe to mirror.onSnapshot to emit session.switched after replaceAll lands.
const snapshotUnsub = mirror.onSnapshot(() => {
  const targetId = pendingSwitchId; // tracked alongside switchFlow.switchTo
  if (targetId === undefined) return;
  // session.switched emitted via the translator branch on Hermes-side flow,
  // OR explicitly here for gateway-initiated switches:
  ws.send(JSON.stringify({
    type: "session.switched",
    sessionId: targetId,
    ts: Date.now(),
  }));
});
cleanupHandles.push(snapshotUnsub);
```

(Pseudocode — adapt names and idioms to the existing file's structure.)

Also add the `?session_id=` resume path: after auth completes but before the existing `conversation.snapshot` is sent, if the connect URL had a `session_id`:

```typescript
const resumeSessionId = sessionConfig.resumeSessionId; // captured from the WS upgrade URL
if (resumeSessionId) {
  try {
    await switchFlow.switchTo(resumeSessionId);
    // mirror.replaceAll already happened inside switchFlow; conversation.snapshot
    // will be emitted by the existing snapshot path which reads mirror.snapshot().
  } catch (err) {
    log.warn("resume:failed", { resumeSessionId, message: (err as Error).message });
    // Mirror stays empty; client falls back to new chat.
  }
}
```

Hook `sessionsHandlers.handle(parsed)` into the inbound message switch for the new frame types.

Add an attention-gate call to clear conversation salience after a switch:

```typescript
// inside the switch-completion path (after switchFlow.switchTo resolves):
attentionGate.clearConversationSalience();
```

- [ ] **Step 4: Add `clearConversationSalience()` to attention-gate**

Open `gateway/src/cerebrum/attention-gate.ts`. Locate the existing salience accumulators (per `architecture.md`: `conversationSalience`, `ambientSalience`). Add a public method:

```typescript
clearConversationSalience(): void {
  conversationSalience = 0;
  log.debug("conversation-salience cleared via switch");
}
```

(Adjust to match the file's existing closure-vs-class style.)

Update the existing test for attention-gate if it asserts on the surface area.

- [ ] **Step 5: Run gateway tests**

```bash
cd gateway && bun run test
```

Expected: existing + new tests all PASS. Fix any breakage from interface changes inline.

- [ ] **Step 6: Typecheck**

```bash
cd gateway && bun run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/session-handlers/ws-session-configure.ts \
        gateway/src/cerebrum/attention-gate.ts
git commit -m "$(cat <<'EOF'
feat(gateway): integrate sessions handlers + switch flow + resume on connect

Wires HermesSessionsClient, TitleStore, SwitchFlow, and SessionsHandlers
into the session configure path. Honors ?session_id= on the WS connect
URL to rehydrate the conversation mirror as part of session-ready.
AttentionGate gains clearConversationSalience() invoked on switch to
prevent stale conversation-salience from triggering an immediate cycle
on the new chain.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 11 — SDK ConversationHistoryConnector (snapshot replace + gen counter)

### Task 11.1: Snapshot REPLACES local mirror; gen counter drops stale entries

**Files:**
- Modify: `shared/web-sdk/src/connectors/conversation-history-connector.ts`
- Modify: `shared/web-sdk/src/connectors/conversation-history-connector.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `shared/web-sdk/src/connectors/conversation-history-connector.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ConversationHistoryConnector } from "./conversation-history-connector.ts";

const fakeSdk = () => {
  const handlers: Record<string, ((m: unknown) => void)[]> = {};
  return {
    onMessage(type: string, fn: (m: unknown) => void) {
      (handlers[type] ??= []).push(fn);
      return () => {};
    },
    emit(type: string, msg: unknown) {
      for (const h of handlers[type] ?? []) h(msg);
    },
  };
};

describe("ConversationHistoryConnector — snapshot replace semantics", () => {
  it("subsequent snapshot replaces, does not merge", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 1, channel: "text", content: "old" }] });
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 2, channel: "text", content: "new" }] });
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("new");
  });

  it("conversation.entry between session.switched and next snapshot is dropped", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 1, channel: "text", content: "a" }] });
    expect(c.items()).toHaveLength(1);
    sdk.emit("session.switched", { sessionId: "s2", ts: 2 });
    sdk.emit("conversation.entry", { item: { kind: "user", ts: 3, channel: "text", content: "stale" } });
    // Mirror still shows old session's snapshot — the stale entry was dropped during the gap.
    expect(c.items().some((i) => (i as { content?: string }).content === "stale")).toBe(false);
  });

  it("snapshot after session.switched releases the gate; subsequent entries apply", () => {
    const sdk = fakeSdk();
    const c = new ConversationHistoryConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 1, channel: "text", content: "a" }] });
    sdk.emit("session.switched", { sessionId: "s2", ts: 2 });
    sdk.emit("conversation.snapshot", { items: [{ kind: "user", ts: 4, channel: "text", content: "fresh" }] });
    expect(c.items()).toHaveLength(1);
    expect((c.items()[0] as { content: string }).content).toBe("fresh");
    sdk.emit("conversation.entry", { item: { kind: "user", ts: 5, channel: "text", content: "live" } });
    expect(c.items()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd shared/web-sdk && bun run test src/connectors/conversation-history-connector.test.ts
```

Expected: at least the third test fails ("stale entry after switched should be dropped").

- [ ] **Step 3: Implement**

Edit `shared/web-sdk/src/connectors/conversation-history-connector.ts`:

```typescript
export class ConversationHistoryConnector implements Connector {
  readonly capability = "conversation.history";
  readonly kind = "status" as const;

  private readonly config: ConversationHistoryConfig;
  private unsubs: (() => void)[] = [];
  private mirror: ConversationFeedItem[] = [];
  // Generation token: bumped on session.switched, anchored on every snapshot.
  // Entries received between session.switched and the next snapshot are dropped.
  private generation = 0;
  private awaitingSnapshot = false;

  constructor(config: ConversationHistoryConfig = {}) {
    this.config = config;
  }

  items(): readonly ConversationFeedItem[] {
    return this.mirror;
  }

  attach(sdk: SentientSDKInternal): void {
    this.mirror = [];
    this.generation = 0;
    this.awaitingSnapshot = false;

    this.unsubs.push(
      sdk.onMessage("conversation.snapshot", (msg: unknown) => {
        const m = msg as { items?: ConversationFeedItem[] };
        const items = Array.isArray(m.items) ? m.items : [];
        this.mirror = [...items]; // REPLACE, not merge
        this.awaitingSnapshot = false;
        this.config.onSnapshot?.(this.mirror);
        this.config.onUpdate?.(this.mirror);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("conversation.entry", (msg: unknown) => {
        if (this.awaitingSnapshot) return; // drop straggler from prior generation
        const m = msg as { item?: ConversationFeedItem };
        if (!m.item) return;
        this.mirror = [...this.mirror, m.item];
        this.config.onEntry?.(m.item);
        this.config.onUpdate?.(this.mirror);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("session.switched", () => {
        this.generation += 1;
        this.awaitingSnapshot = true;
      }),
    );
  }

  detach(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.mirror = [];
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd shared/web-sdk && bun run test src/connectors/conversation-history-connector.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/connectors/conversation-history-connector.ts \
        shared/web-sdk/src/connectors/conversation-history-connector.test.ts
git commit -m "$(cat <<'EOF'
feat(web-sdk): snapshot replaces; drop entries between switched + next snapshot

ConversationHistoryConnector now replaces (not merges) on every
conversation.snapshot, bumps a generation token on session.switched,
and drops conversation.entry events received during the switching
window. Prevents stale bubbles from leaking into a freshly-rehydrated
chat view.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 12 — SessionsConnector (browser SDK)

### Task 12.1: Implement SessionsConnector

**Files:**
- Create: `shared/web-sdk/src/connectors/sessions-connector.ts`
- Create: `shared/web-sdk/src/connectors/sessions-connector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `shared/web-sdk/src/connectors/sessions-connector.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { SessionsConnector } from "./sessions-connector.ts";

const fakeSdk = () => {
  const handlers: Record<string, ((m: unknown) => void)[]> = {};
  const sent: Record<string, unknown>[] = [];
  return {
    onMessage(type: string, fn: (m: unknown) => void) {
      (handlers[type] ??= []).push(fn);
      return () => {};
    },
    send(msg: Record<string, unknown>) {
      sent.push(msg);
    },
    emit(type: string, msg: unknown) {
      for (const h of handlers[type] ?? []) h(msg);
    },
    sent,
  };
};

describe("SessionsConnector", () => {
  it("list — sends frame, resolves on result with matching requestId", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.list({ limit: 20, offset: 0 });
    const sent = sdk.sent[0] as { requestId: string };
    sdk.emit("sessions.list.result", {
      requestId: sent.requestId,
      items: [],
      total: 0,
      hasMore: false,
    });
    await expect(p).resolves.toEqual({ items: [], total: 0, hasMore: false });
  });

  it("list — rejects on sessions.error matching requestId", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.list({ limit: 20, offset: 0 });
    const sent = sdk.sent[0] as { requestId: string };
    sdk.emit("sessions.error", { requestId: sent.requestId, code: "internal", message: "boom" });
    await expect(p).rejects.toThrow(/boom/);
  });

  it("delete — broadcasts SessionsChangeEvent on sessions.deleted", () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    const onChange = vi.fn();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    c.onSessionsChanged(onChange);
    sdk.emit("sessions.deleted", { sessionId: "s1" });
    expect(onChange).toHaveBeenCalledWith({ kind: "deleted", sessionId: "s1" });
  });

  it("switchTo — resolves on session.switched", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.switchTo("s1");
    sdk.emit("session.switched", { sessionId: "s1", ts: 1 });
    await expect(p).resolves.toBeUndefined();
  });

  it("newChat — resolves with sessionId on session.created", async () => {
    const sdk = fakeSdk();
    const c = new SessionsConnector();
    c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
    const p = c.newChat();
    sdk.emit("session.created", { sessionId: "s2", ts: 1 });
    await expect(p).resolves.toEqual({ sessionId: "s2" });
  });

  it("request times out and rejects with TimeoutError", async () => {
    vi.useFakeTimers();
    try {
      const sdk = fakeSdk();
      const c = new SessionsConnector({ timeoutMs: 50 });
      c.attach(sdk as unknown as Parameters<typeof c.attach>[0]);
      const p = c.list({ limit: 20, offset: 0 });
      vi.advanceTimersByTime(60);
      await expect(p).rejects.toThrow(/timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd shared/web-sdk && bun run test src/connectors/sessions-connector.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `shared/web-sdk/src/connectors/sessions-connector.ts`:

```typescript
import type { SessionRow } from "@sentient/protocol";
import type { Connector, SentientSDKInternal } from "../connector-types.ts";

const DEFAULT_TIMEOUT_MS = 5000;

export type SessionsChangeEvent =
  | { kind: "created"; sessionId: string; title?: string; ts: number }
  | { kind: "switched"; sessionId: string; title?: string; ts: number }
  | { kind: "deleted"; sessionId: string }
  | { kind: "renamed"; sessionId: string; title: string };

export interface SessionsConnectorConfig {
  readonly timeoutMs?: number;
}

interface PendingRequest {
  requestId: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const newId = (): string => {
  // Browsers + Bun both ship crypto.randomUUID.
  return globalThis.crypto.randomUUID();
};

export class SessionsConnector implements Connector {
  readonly capability = "sessions";
  readonly kind = "status" as const;

  private readonly timeoutMs: number;
  private pending: Map<string, PendingRequest> = new Map();
  private listeners: Set<(e: SessionsChangeEvent) => void> = new Set();
  private unsubs: (() => void)[] = [];
  private send: (msg: Record<string, unknown>) => void = () => {};

  constructor(cfg: SessionsConnectorConfig = {}) {
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  attach(sdk: SentientSDKInternal): void {
    this.send = (msg) => sdk.send(msg);

    const matchToPending = (msg: { requestId?: string }): PendingRequest | undefined => {
      const id = msg.requestId;
      if (!id) return undefined;
      const p = this.pending.get(id);
      if (p) this.pending.delete(id);
      return p;
    };

    this.unsubs.push(
      sdk.onMessage("sessions.list.result", (raw: unknown) => {
        const m = raw as { requestId: string; items: SessionRow[]; total: number; hasMore: boolean };
        const p = matchToPending(m);
        if (!p) return;
        clearTimeout(p.timer);
        p.resolve({ items: m.items, total: m.total, hasMore: m.hasMore });
      }),
    );

    this.unsubs.push(
      sdk.onMessage("sessions.search.result", (raw: unknown) => {
        const m = raw as { requestId: string; items: SessionRow[] };
        const p = matchToPending(m);
        if (!p) return;
        clearTimeout(p.timer);
        p.resolve(m.items);
      }),
    );

    this.unsubs.push(
      sdk.onMessage("sessions.error", (raw: unknown) => {
        const m = raw as { requestId: string; code: string; message: string };
        const p = matchToPending(m);
        if (!p) return;
        clearTimeout(p.timer);
        p.reject(new Error(`${m.code}: ${m.message}`));
      }),
    );

    this.unsubs.push(
      sdk.onMessage("sessions.deleted", (raw: unknown) => {
        const m = raw as { sessionId: string };
        this.dispatch({ kind: "deleted", sessionId: m.sessionId });
      }),
    );

    this.unsubs.push(
      sdk.onMessage("sessions.renamed", (raw: unknown) => {
        const m = raw as { sessionId: string; title: string };
        this.dispatch({ kind: "renamed", sessionId: m.sessionId, title: m.title });
      }),
    );

    this.unsubs.push(
      sdk.onMessage("session.created", (raw: unknown) => {
        const m = raw as { sessionId: string; title?: string; ts: number };
        this.dispatch({ kind: "created", sessionId: m.sessionId, title: m.title, ts: m.ts });
        // newChat() and friends resolve here too via pending lookup using the session.created
        // payload's correlation field if set. Spec uses session.created without requestId, so
        // newChat() has its own resolution path below.
      }),
    );

    this.unsubs.push(
      sdk.onMessage("session.switched", (raw: unknown) => {
        const m = raw as { sessionId: string; title?: string; ts: number };
        this.dispatch({ kind: "switched", sessionId: m.sessionId, title: m.title, ts: m.ts });
      }),
    );
  }

  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("connector detached"));
    }
    this.pending.clear();
    this.listeners.clear();
  }

  private dispatch(e: SessionsChangeEvent): void {
    for (const l of this.listeners) l(e);
  }

  private request<T>(frame: Record<string, unknown>): Promise<T> {
    const requestId = newId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`timeout waiting for ${frame.type}`));
        }
      }, this.timeoutMs);
      this.pending.set(requestId, { requestId, resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ ...frame, requestId });
    });
  }

  list(opts: { limit: number; offset: number }): Promise<{ items: SessionRow[]; total: number; hasMore: boolean }> {
    return this.request({ type: "sessions.list", ...opts });
  }
  search(q: string, limit = 20): Promise<SessionRow[]> {
    return this.request({ type: "sessions.search", q, limit });
  }
  delete(sessionId: string): Promise<void> {
    return this.request<void>({ type: "sessions.delete", sessionId });
  }
  rename(sessionId: string, title: string): Promise<void> {
    return this.request<void>({ type: "sessions.rename", sessionId, title });
  }
  switchTo(sessionId: string): Promise<void> {
    // session.switched arrives without requestId — special-cased.
    return new Promise((resolve, reject) => {
      const off = (() => {
        const onSwitched = (e: SessionsChangeEvent): void => {
          if (e.kind === "switched" && e.sessionId === sessionId) {
            cleanup();
            resolve();
          }
        };
        this.listeners.add(onSwitched);
        return () => this.listeners.delete(onSwitched);
      })();
      const timer = setTimeout(() => {
        off();
        reject(new Error("timeout waiting for session.switched"));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        off();
      };
      this.send({ type: "session.switch", sessionId, requestId: newId() });
    });
  }
  newChat(): Promise<{ sessionId: string }> {
    return new Promise((resolve, reject) => {
      const onCreated = (e: SessionsChangeEvent): void => {
        if (e.kind === "created") {
          cleanup();
          resolve({ sessionId: e.sessionId });
        }
      };
      this.listeners.add(onCreated);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout waiting for session.created"));
      }, this.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.listeners.delete(onCreated);
      };
      this.send({ type: "session.new", requestId: newId() });
    });
  }
  onSessionsChanged(fn: (e: SessionsChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd shared/web-sdk && bun run test src/connectors/sessions-connector.test.ts
```

Expected: all 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/connectors/sessions-connector.ts \
        shared/web-sdk/src/connectors/sessions-connector.test.ts
git commit -m "$(cat <<'EOF'
feat(web-sdk): SessionsConnector (list/search/delete/rename/new/switch)

requestId-correlated request/response, timeout-bounded promises,
broadcast event surface for created/switched/deleted/renamed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 13 — Cross-tab sync via BroadcastChannel

### Task 13.1: cross-tab-sync.ts

**Files:**
- Create: `shared/web-sdk/src/cross-tab-sync.ts`
- Create: `shared/web-sdk/src/cross-tab-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `shared/web-sdk/src/cross-tab-sync.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createCrossTabSync } from "./cross-tab-sync.ts";

describe("CrossTabSync", () => {
  it("broadcast → listen on a sibling channel of the same name", async () => {
    const a = createCrossTabSync({ userId: "u1" });
    const b = createCrossTabSync({ userId: "u1" });
    const seen = vi.fn();
    b.onEvent(seen);
    a.broadcast({ kind: "deleted", sessionId: "s1" });
    // BroadcastChannel delivers asynchronously; allow a microtask flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveBeenCalledWith({ kind: "deleted", sessionId: "s1" });
    a.dispose();
    b.dispose();
  });

  it("dispose unsubscribes", async () => {
    const a = createCrossTabSync({ userId: "u1" });
    const b = createCrossTabSync({ userId: "u1" });
    const seen = vi.fn();
    b.onEvent(seen);
    b.dispose();
    a.broadcast({ kind: "renamed", sessionId: "s1", title: "x" });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).not.toHaveBeenCalled();
    a.dispose();
  });

  it("ignores messages on a different userId", async () => {
    const a = createCrossTabSync({ userId: "u1" });
    const b = createCrossTabSync({ userId: "u2" });
    const seen = vi.fn();
    b.onEvent(seen);
    a.broadcast({ kind: "deleted", sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).not.toHaveBeenCalled();
    a.dispose();
    b.dispose();
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd shared/web-sdk && bun run test src/cross-tab-sync.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `shared/web-sdk/src/cross-tab-sync.ts`:

```typescript
import type { SessionsChangeEvent } from "./connectors/sessions-connector.ts";

export interface CrossTabSync {
  broadcast(event: SessionsChangeEvent): void;
  onEvent(fn: (event: SessionsChangeEvent) => void): () => void;
  dispose(): void;
}

export interface CrossTabSyncConfig {
  readonly userId: string;
}

const NAME_PREFIX = "sentient-sessions:";

export function createCrossTabSync(cfg: CrossTabSyncConfig): CrossTabSync {
  const channelName = `${NAME_PREFIX}${cfg.userId}`;
  const channel = new BroadcastChannel(channelName);
  const listeners: Set<(e: SessionsChangeEvent) => void> = new Set();

  const handler = (msg: MessageEvent): void => {
    const data = msg.data as SessionsChangeEvent;
    for (const l of listeners) {
      try {
        l(data);
      } catch {
        /* listener errors non-fatal */
      }
    }
  };
  channel.addEventListener("message", handler);

  return {
    broadcast(event) {
      channel.postMessage(event);
    },
    onEvent(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    dispose() {
      channel.removeEventListener("message", handler);
      channel.close();
      listeners.clear();
    },
  };
}
```

- [ ] **Step 4: Run tests**

```bash
cd shared/web-sdk && bun run test src/cross-tab-sync.test.ts
```

Expected: 3 PASS. NOTE: vitest needs `BroadcastChannel`. Bun ships it natively; if vitest's runtime is jsdom-only, ensure `vitest.config.ts` selects `happy-dom` or `node` for this file. Adjust if the test fails with "BroadcastChannel is not defined".

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/cross-tab-sync.ts \
        shared/web-sdk/src/cross-tab-sync.test.ts
git commit -m "$(cat <<'EOF'
feat(web-sdk): cross-tab sync via BroadcastChannel

Tabs from the same browser + same user share session change events
(deleted / renamed / switched / created) over a per-userId channel.
Used by the webui to keep multiple open tabs' lists in sync without
extra WS chatter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 14 — Reconnect URL with session_id

### Task 14.1: Append session_id to the WS connect URL

**Files:**
- Modify: `shared/web-sdk/src/sdk-reconnect.ts`
- Modify: `shared/web-sdk/src/sentient-sdk.ts`

- [ ] **Step 1: Read current connect-URL builder**

```bash
grep -nE "(buildWsUrl|new URL\(|wss://|searchParams)" shared/web-sdk/src/sdk-reconnect.ts shared/web-sdk/src/sentient-sdk.ts | head -20
```

Note the function that produces the WS URL. Likely it accepts a token and returns a string.

- [ ] **Step 2: Add `currentSessionId` query param**

In the URL builder, append `session_id` from `sessionStorage` if present:

```typescript
const buildConnectUrl = (base: string, token: string): string => {
  const u = new URL(base);
  u.searchParams.set("token", token);
  const stored = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("sentient.currentSessionId") : null;
  if (stored) u.searchParams.set("session_id", stored);
  return u.toString();
};
```

(Adapt to the file's idiom.)

- [ ] **Step 3: Update sentient-sdk.ts to write currentSessionId on session.switched/created**

Locate the SDK's message router. Add:

```typescript
sdk.onMessage("session.switched", (msg: unknown) => {
  const m = msg as { sessionId: string };
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem("sentient.currentSessionId", m.sessionId);
  }
});
sdk.onMessage("session.created", (msg: unknown) => {
  const m = msg as { sessionId: string };
  if (m.sessionId && typeof sessionStorage !== "undefined") {
    sessionStorage.setItem("sentient.currentSessionId", m.sessionId);
  }
});
```

And on a 404-resume fallback (gateway sends conversation.snapshot with empty array WITHOUT a preceding session.switched), clear it:

```typescript
// Inside the snapshot handler in sentient-sdk.ts:
sdk.onMessage("conversation.snapshot", (msg: unknown) => {
  const m = msg as { items?: unknown[] };
  // If we connected with a session_id but no session.switched preceded this snapshot,
  // the gateway fell back to fresh-new — clear localStorage so we don't keep retrying it.
  if (resumeFell404 && typeof sessionStorage !== "undefined") {
    sessionStorage.removeItem("sentient.currentSessionId");
  }
});
```

(Tracking the fallback flag requires a small bit of state — implement via a `pendingResume: boolean` ref set in `buildConnectUrl` if `session_id` was attached.)

- [ ] **Step 4: Existing reconnect tests**

```bash
cd shared/web-sdk && bun run test src/sdk-reconnect.test.ts
```

Expected: still PASS — reconnect logic itself unchanged.

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/sdk-reconnect.ts \
        shared/web-sdk/src/sentient-sdk.ts
git commit -m "$(cat <<'EOF'
feat(web-sdk): thread currentSessionId through WS connect URL

sessionStorage[sentient.currentSessionId] is appended to the WS
connect URL as ?session_id=, so a reconnecting tab lands back on its
prior chain via the gateway resume path. session.switched and
session.created update the pointer; a 404 fallback clears it so the
tab doesn't hammer a deleted id forever.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 15 — WebUI components

### Task 15.1: Sessions hook + components

**Files:**
- Create: `gateway/webui/src/hooks/use-sessions.ts`
- Create: `gateway/webui/src/components/sessions/Drawer.tsx`
- Create: `gateway/webui/src/components/sessions/SessionList.tsx`
- Create: `gateway/webui/src/components/sessions/SessionRow.tsx`
- Create: `gateway/webui/src/components/sessions/SessionSearchBox.tsx`
- Create: `gateway/webui/src/components/sessions/DateGroupHeader.tsx`
- Create: `gateway/webui/src/components/sessions/NewChatButton.tsx`
- Modify: existing top-bar to wire the hamburger button

NOTE: per `testing.md` we do NOT write component snapshot/render tests for these. Smoke covers them.

- [ ] **Step 1: Read existing top-bar and design-token files**

```bash
ls gateway/webui/src/components/ | head -30
grep -nE "(Hamburger|TopBar|MenuButton)" gateway/webui/src/components/*.tsx 2>/dev/null | head
```

Identify where the existing hamburger lives, the chat-store / signals, and the SDK provider.

- [ ] **Step 2: Implement the hook**

Create `gateway/webui/src/hooks/use-sessions.ts`:

```typescript
import { signal, computed } from "@preact/signals";
import type { SessionRow } from "@sentient/protocol";
import type { SessionsConnector, SessionsChangeEvent } from "@sentient/web-sdk";

export interface UseSessions {
  readonly items: ReturnType<typeof signal<SessionRow[]>>;
  readonly searchHits: ReturnType<typeof signal<SessionRow[] | null>>;
  readonly loading: ReturnType<typeof signal<boolean>>;
  readonly error: ReturnType<typeof signal<string | null>>;
  readonly currentId: ReturnType<typeof signal<string | null>>;
  load(): Promise<void>;
  search(q: string): Promise<void>;
  switchTo(id: string): Promise<void>;
  newChat(): Promise<void>;
  delete(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  dispose(): void;
}

export function createUseSessions(connector: SessionsConnector): UseSessions {
  const items = signal<SessionRow[]>([]);
  const searchHits = signal<SessionRow[] | null>(null);
  const loading = signal(false);
  const err = signal<string | null>(null);
  const currentId = signal<string | null>(
    typeof sessionStorage !== "undefined" ? sessionStorage.getItem("sentient.currentSessionId") : null,
  );

  const offChange = connector.onSessionsChanged((e: SessionsChangeEvent) => {
    if (e.kind === "deleted") {
      items.value = items.value.filter((r) => r.sessionId !== e.sessionId);
      if (currentId.value === e.sessionId) currentId.value = null;
    }
    if (e.kind === "renamed") {
      items.value = items.value.map((r) => (r.sessionId === e.sessionId ? { ...r, title: e.title } : r));
    }
    if (e.kind === "switched") currentId.value = e.sessionId;
    if (e.kind === "created") {
      currentId.value = e.sessionId;
      // Optimistic: prepend a placeholder row; next list() call replaces.
      items.value = [
        {
          sessionId: e.sessionId,
          rootId: e.sessionId,
          title: e.title ?? "New chat",
          startedAt: e.ts,
          lastActiveAt: e.ts,
          messageCount: 0,
          preview: "",
          isActive: true,
        },
        ...items.value.filter((r) => r.sessionId !== e.sessionId),
      ];
    }
  });

  return {
    items,
    searchHits,
    loading,
    error: err,
    currentId,
    async load() {
      loading.value = true;
      err.value = null;
      try {
        const { items: rows } = await connector.list({ limit: 50, offset: 0 });
        items.value = rows;
      } catch (e: unknown) {
        err.value = (e as Error).message;
      } finally {
        loading.value = false;
      }
    },
    async search(q) {
      if (!q.trim()) {
        searchHits.value = null;
        return;
      }
      try {
        const hits = await connector.search(q, 20);
        searchHits.value = hits;
      } catch (e: unknown) {
        err.value = (e as Error).message;
      }
    },
    async switchTo(id) {
      await connector.switchTo(id);
      currentId.value = id;
    },
    async newChat() {
      const { sessionId } = await connector.newChat();
      currentId.value = sessionId;
    },
    async delete(id) {
      await connector.delete(id);
    },
    async rename(id, title) {
      await connector.rename(id, title);
    },
    dispose() {
      offChange();
    },
  };
}
```

- [ ] **Step 3: Implement DateGroupHeader (pure helper)**

Create `gateway/webui/src/components/sessions/DateGroupHeader.tsx`:

```tsx
const DAY = 86_400_000;

export function dateGroupLabel(nowMs: number, lastActiveMs: number): string {
  const today = Math.floor(nowMs / DAY);
  const day = Math.floor(lastActiveMs / DAY);
  if (day === today) return "Today";
  if (day === today - 1) return "Yesterday";
  if (today - day < 7) return "Last 7 days";
  return "Older";
}

export function DateGroupHeader({ label }: { label: string }) {
  return <div class="sessions-date-group" role="presentation">{label}</div>;
}
```

- [ ] **Step 4: Implement SessionRow**

Create `gateway/webui/src/components/sessions/SessionRow.tsx`:

```tsx
import { useState } from "preact/hooks";
import type { SessionRow as Row } from "@sentient/protocol";

export interface SessionRowProps {
  row: Row;
  isCurrent: boolean;
  onSwitch: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}

export function SessionRow({ row, isCurrent, onSwitch, onDelete, onRename }: SessionRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.title);

  const submit = () => {
    const next = draft.trim().slice(0, 200);
    if (next && next !== row.title) onRename(next);
    setEditing(false);
  };

  return (
    <button
      class={`session-row ${isCurrent ? "session-row--current" : ""}`}
      onClick={() => !editing && onSwitch()}
      type="button"
    >
      <div class="session-row__main">
        {editing ? (
          <input
            class="session-row__title-input"
            value={draft}
            maxLength={200}
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") {
                setDraft(row.title);
                setEditing(false);
              }
            }}
            autoFocus
          />
        ) : (
          <div class="session-row__title">{row.title}</div>
        )}
        <div class="session-row__preview">{row.preview}</div>
      </div>
      <div class="session-row__menu" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => setEditing(true)}>Rename</button>
        <button type="button" onClick={() => onDelete()}>Delete</button>
      </div>
    </button>
  );
}
```

- [ ] **Step 5: Implement SessionSearchBox, SessionList, NewChatButton, Drawer**

Create `gateway/webui/src/components/sessions/SessionSearchBox.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";

export function SessionSearchBox({ onChange }: { onChange: (q: string) => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => onChange(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <input
      class="session-search-box"
      placeholder="Search past chats"
      value={q}
      onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
      maxLength={200}
    />
  );
}
```

Create `gateway/webui/src/components/sessions/NewChatButton.tsx`:

```tsx
export function NewChatButton({ onClick }: { onClick: () => void }) {
  return (
    <button class="new-chat-button" type="button" onClick={onClick}>
      + New chat
    </button>
  );
}
```

Create `gateway/webui/src/components/sessions/SessionList.tsx`:

```tsx
import type { SessionRow as Row } from "@sentient/protocol";
import { dateGroupLabel, DateGroupHeader } from "./DateGroupHeader.tsx";
import { SessionRow } from "./SessionRow.tsx";

export interface SessionListProps {
  rows: readonly Row[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

export function SessionList({ rows, currentId, onSwitch, onDelete, onRename }: SessionListProps) {
  if (rows.length === 0) {
    return <div class="session-list session-list--empty">No past chats yet.</div>;
  }
  const now = Date.now();
  const groups: { label: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const label = dateGroupLabel(now, row.lastActiveAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return (
    <div class="session-list">
      {groups.map((g) => (
        <div key={g.label} class="session-list__group">
          <DateGroupHeader label={g.label} />
          {g.rows.map((row) => (
            <SessionRow
              key={row.sessionId}
              row={row}
              isCurrent={row.sessionId === currentId}
              onSwitch={() => onSwitch(row.sessionId)}
              onDelete={() => onDelete(row.sessionId)}
              onRename={(t) => onRename(row.sessionId, t)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
```

Create `gateway/webui/src/components/sessions/Drawer.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import { useSessionsContext } from "../../context/sessions.tsx"; // wire below
import { SessionList } from "./SessionList.tsx";
import { SessionSearchBox } from "./SessionSearchBox.tsx";
import { NewChatButton } from "./NewChatButton.tsx";

export function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useSessionsContext();
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (open) sessions.load();
  }, [open]);

  const visible = sessions.searchHits.value ?? sessions.items.value;
  return (
    <div class={`drawer ${open ? "drawer--open" : ""}`} aria-hidden={!open}>
      <div class="drawer__backdrop" onClick={onClose} />
      <div class="drawer__panel">
        <NewChatButton
          onClick={async () => {
            await sessions.newChat();
            onClose();
          }}
        />
        <SessionSearchBox
          onChange={async (q) => {
            setSearching(q.length > 0);
            await sessions.search(q);
          }}
        />
        <SessionList
          rows={visible}
          currentId={sessions.currentId.value}
          onSwitch={async (id) => {
            await sessions.switchTo(id);
            onClose();
          }}
          onDelete={(id) => sessions.delete(id)}
          onRename={(id, t) => sessions.rename(id, t)}
        />
      </div>
    </div>
  );
}
```

Create the sessions context provider `gateway/webui/src/context/sessions.tsx`:

```tsx
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { UseSessions } from "../hooks/use-sessions.ts";

const SessionsContext = createContext<UseSessions | null>(null);

export const SessionsProvider = SessionsContext.Provider;

export function useSessionsContext(): UseSessions {
  const v = useContext(SessionsContext);
  if (!v) throw new Error("SessionsProvider missing");
  return v;
}
```

Wire `SessionsProvider` and the SDK's `SessionsConnector` in your existing app root (`gateway/webui/src/app.tsx` or equivalent). Hook the existing hamburger button to toggle the `Drawer`.

- [ ] **Step 6: Add minimal CSS**

In your existing webui CSS (e.g. `gateway/webui/src/app.css` or design-token file), add the new selectors:

```css
.drawer { position: fixed; inset: 0; pointer-events: none; }
.drawer--open { pointer-events: auto; }
.drawer__backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.5); opacity: 0; transition: opacity 200ms; }
.drawer--open .drawer__backdrop { opacity: 1; }
.drawer__panel {
  position: absolute; top: 0; left: 0; bottom: 0;
  width: min(360px, 85vw);
  background: var(--bg-elev, #111);
  transform: translateX(-100%); transition: transform 200ms;
  display: flex; flex-direction: column; gap: 8px; padding: 12px;
  overflow-y: auto;
}
.drawer--open .drawer__panel { transform: translateX(0); }

.session-row {
  display: flex; align-items: stretch; gap: 8px;
  min-height: 44px; padding: 8px 12px;
  border: none; background: transparent; color: inherit;
  text-align: left; cursor: pointer;
}
.session-row--current { background: var(--bg-active, rgba(255,255,255,0.06)); }
.session-row__title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-row__preview { font-size: 0.85em; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sessions-date-group { font-size: 0.75em; opacity: 0.6; padding: 4px 12px; }
.session-list--empty { padding: 16px; opacity: 0.6; }
.session-search-box { width: 100%; padding: 8px 12px; }
.new-chat-button { width: 100%; padding: 12px; min-height: 44px; }
```

(Adjust to existing token system. Visual polish belongs in a UI refinement pass after smoke proves the wiring.)

- [ ] **Step 7: Lint + typecheck**

```bash
cd gateway/webui && bun run lint
cd .. && bun run typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add gateway/webui/src/hooks/use-sessions.ts \
        gateway/webui/src/components/sessions/ \
        gateway/webui/src/context/sessions.tsx \
        gateway/webui/src/app.tsx \
        gateway/webui/src/app.css
# (add the actual file paths you wired into the app root)
git commit -m "$(cat <<'EOF'
feat(webui): hamburger drawer with sessions list + search + rename + delete

Drawer slides in from left (~85vw on mobile), houses New Chat button,
search box, and a virtualizable session list with date-group headers
and inline rename/delete via row controls. Hooks SessionsConnector
through a new SessionsProvider context.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 16 — Config + smoke matrix

### Task 16.1: Add sessions: config block

**Files:**
- Modify: `gateway/config.yaml`
- Modify: gateway config loader (`gateway/src/config/...`)

- [ ] **Step 1: Append to `gateway/config.yaml`**

```yaml
sessions:
  list_page_size: 20
  search_max_results: 20
  search_min_chars: 2
  search_debounce_ms: 300
  title_max_chars: 200
  title_override_dir: ~/.sentient/gateway/session-titles
  source_tag: sentient-user
  hermes_http_timeout_ms: 5000
  switch_teardown_timeout_ms: 3000
```

Each value gets an inline comment per `config.md`:

```yaml
sessions:
  list_page_size: 20         # default page size for sessions.list (1-100)
  search_max_results: 20     # cap on FTS results (1-50)
  search_min_chars: 2        # debounce floor; queries shorter dropped
  search_debounce_ms: 300    # client-side debounce — surfaced for tuning
  title_max_chars: 200       # rename input bound
  title_override_dir: ~/.sentient/gateway/session-titles  # per-profile JSON store
  source_tag: sentient-user  # adapter writes this on every new chain
  hermes_http_timeout_ms: 5000           # per-request timeout for Hermes /api/sessions/*
  switch_teardown_timeout_ms: 3000       # max wait for cycle-cancel before switch proceeds
```

- [ ] **Step 2: Update the loader's zod schema**

Find the existing config schema (likely `gateway/src/config/schema.ts`) and add the `sessions` block. Mirror the YAML keys exactly.

- [ ] **Step 3: Run gateway tests**

```bash
cd gateway && bun run test
bun run typecheck
bun run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add gateway/config.yaml gateway/src/config/
git commit -m "$(cat <<'EOF'
feat(config): add sessions: block

Tunables for the past-sessions feature: pagination caps, search
bounds, title length, override-store location, source tag, HTTP
timeout, switch teardown timeout. All defaults in YAML, code reads
at startup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 16.2: Run the full smoke matrix on Mac local stack

**Files:** none (verification only)

This task is gated by `.claude/rules/e2e-testing.md` — agent owns it.

- [ ] **Step 1: Bringup**

```bash
source scripts/env.sh
HOST_DOCKER_GID=0 docker compose -f deploy/macos/docker-compose.yml build gateway
HOST_DOCKER_GID=0 docker compose -f deploy/macos/docker-compose.yml up -d
until curl -sk -o /dev/null -w "%{http_code}" https://localhost:8888/ | grep -q 200; do sleep 1; done
```

- [ ] **Step 2: Run desktop matrix via Playwright MCP**

Use Playwright MCP at viewport 1280×900. Walk every row of the **Desktop matrix** in the spec:

- Empty list / fresh user
- New chat from empty
- Multi-session ordering
- Resume idle session
- Resume mid-cycle
- Search hit / no-hit / prefix
- Date grouping
- Rename
- Delete current / non-current
- Active highlight
- Reconnect with valid `?session_id=`
- Reconnect with stale `?session_id=`
- Cross-profile guard (forge via `evaluate_script`)
- Cross-tab sync delete + rename
- Long title rename (rejected at 200)
- Long preview truncation
- Pagination (>page_size)
- Hermes unreachable (kill Hermes container, retry list)
- Concurrent switches
- Empty session resumed
- Send → switch → switch back

Capture: screenshot post-action, console messages, network requests where contract matters. Store evidence under `.playwright-mcp/`.

- [ ] **Step 3: Run mobile matrix (390×844)**

`browser_resize(390, 844)` — walk every mobile-matrix row from the spec:

- Hamburger visible
- Drawer open / backdrop close
- Tap targets ≥44px
- Drawer scroll independence
- Switch from drawer auto-closes drawer

- [ ] **Step 4: Verify log trail clean**

```bash
docker compose -f deploy/macos/docker-compose.yml logs gateway --tail=200 | grep -E "WARN|ERROR" | grep -v "expected-warn-pattern" || echo "clean"
```

Expected: only the documented expected-WARN lines (404 fallback case has its expected WARN; cross-profile reject has its expected WARN). No unexpected ERROR.

- [ ] **Step 5: Document evidence in handover note**

Append to the PR description (when merging) a one-line summary per matrix row, with screenshot links and the specific log line(s) that confirmed each case.

- [ ] **Step 6: Commit any minor fixes uncovered**

If smoke uncovered fixable bugs, commit them on this branch before merging. Do NOT declare done with red cases.

---

## Phase 17 — Pi push + final merge

### Task 17.1: Push the branch + Pi rebuild + container health smoke

**Files:** none (deploy verification)

- [ ] **Step 1: Push branch (only after Phase 16 fully green)**

```bash
git push -u origin feature/past-sessions-and-reconnect
```

- [ ] **Step 2: Open PR to develop, summarize matrix evidence in body**

```bash
gh pr create --title "feat: past sessions list, resume, reconnect simplification" --body "$(cat <<'EOF'
## Summary

- Sessions list (auto-titles, search, date groups, rename, delete, cross-tab sync)
- Click-to-resume via ConversationMirror snapshot rehydration
- New Chat button
- sessionStorage-backed currentSessionId; reconnect threads it through WS connect URL
- One additive overlay patch (source filter on /api/sessions); zero rename patch

## Spec

`docs/superpowers/specs/2026-05-06-past-sessions-and-reconnect-design.md`

## Smoke

Full matrix per `.claude/rules/e2e-testing.md` executed via Playwright MCP on Mac local stack. Evidence in `.playwright-mcp/` (links in commit notes).

## Test plan

- [x] Unit + protocol contract tests pass
- [x] Typecheck + lint clean
- [x] Desktop smoke (1280×900) matrix all green
- [x] Mobile smoke (390×844) matrix all green
- [ ] Pi rebuild healthy + log smoke clean (post-merge or pre-merge)
- [ ] Real iOS Safari smoke (operator follow-up — flagged in spec)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: After merge, deploy to Pi**

```bash
ssh kevinye@hacore.lan "cd ~/sentient && git fetch && git checkout develop && git pull && cd deploy/pi && docker compose build gateway && docker compose up -d gateway"
ssh kevinye@hacore.lan "cd ~/sentient/deploy/pi && docker compose ps && docker compose logs gateway --tail=200 | grep -E 'WARN|ERROR' | grep -v 'expected-warn' || echo 'clean'"
```

- [ ] **Step 4: Confirm healthy**

Expected: `Up X seconds (healthy)` for the gateway container; clean log tail. Post-merge real-user smoke is the operator's job.

---

## Self-review notes (already applied)

- Spec coverage: every spec section maps to a phase task above.
- Type consistency: `SessionRow` from `@sentient/protocol` used in all consumers; `MirrorEntry` for ConversationMirror; `SwitchFlowState` for switch state machine; `SessionsChangeEvent` for cross-tab + connector broadcast.
- No placeholders. Every step contains the actual content.
- Patches: 1 (source filter). Title rename via gateway-side store. Documented in `deploy/hermes-overlay/README.md` (Phase 1.1 step 2).
- Smoke matrix is a row-by-row walk of the spec's matrix; agent-owned per the new e2e-testing rule.
