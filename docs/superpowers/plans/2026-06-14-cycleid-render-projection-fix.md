# cycleId Render-Key Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gateway's client-facing `cycleId` server-unique (one POSIX-ms id per turn, never resetting on reconnect) and make the mobile client dedup committed history by `entryId` — fixing the iOS "follow-up reply missing / previous response shown" (A) and "scroll: bottom message stale" (B) bugs.

**Architecture:** Two coupled changes. (1) `attention-gate.ts` mints `cycleId = String(Date.now())` instead of a per-gate `cycle-${counter}` that reset to `cycle-1` on every reconnect and aliased turns. (2) `ConversationHistoryConnector` dedups committed entries by stable `entryId` instead of blindly appending (kills replayed-entry duplicates). The mobile render keys (`ChatRows` cycleId-first row id, `ObserveChatUseCase` suppression) need **no logic change** — they become correct once `cycleId` is unique; we add guard tests pinning that.

**Tech Stack:** Gateway = Bun/TypeScript + Vitest. Mobile SDK / data = Kotlin Multiplatform commonTest (`kotlin.test`, `kotlinx-coroutines-test`). iOS = Swift Testing. E2E = Playwright MCP (web) + Maestro (iOS).

**Spec:** `docs/superpowers/specs/2026-06-14-cycleid-render-projection-fix-design.md`. **Branch:** `feature/cycleid-render-projection-fix` (already created off develop). **Out of scope:** C/D (phantom sessions, delete).

**Before you start:** `source scripts/env.sh` (puts `bun` on PATH).

---

### Task 1: Server — unique POSIX-ms cycleId

**Files:**
- Modify: `gateway/src/cerebrum/attention-gate.ts:116` (remove `cycleCounter`), `:131-134` (`generateCycleId`)
- Test: `gateway/src/cerebrum/attention-gate.test.ts` (append one test)

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe("AttentionGate", () => { ... })` block in `gateway/src/cerebrum/attention-gate.test.ts` (the helpers `makeCallbacks`, `DEFAULT_CONFIG`, `sleep`, `testSalienceMap`, `makeConversationMirror`, `createShortTermContext` already exist in that file):

```ts
it("mints a unique POSIX-ms cycleId per turn that does not reset when the gate is re-created (reconnect)", async () => {
  // Every session.configure builds a NEW AttentionGate. Two gates simulate a
  // reconnect. OLD behaviour: both minted "cycle-1" (per-gate counter) → the
  // client aliased two different turns onto one render row.
  async function dispatchOnceOnAFreshGate(): Promise<string> {
    const ctx = createShortTermContext("sess-x", testSalienceMap);
    const conversationMirror = makeConversationMirror();
    const { callbacks, cycleCalls } = makeCallbacks();
    createAttentionGate(ctx, DEFAULT_CONFIG, callbacks, conversationMirror, testSalienceMap);
    // "conversation.user.speech" => reply 85 > standard threshold 50 → fires after debounce.
    conversationMirror.append({ entryId: "e", kind: "user", ts: Date.now(), channel: "speech", content: "hi" });
    await sleep(DEFAULT_CONFIG.debounceWindowMs + 40);
    expect(cycleCalls).toHaveLength(1);
    return cycleCalls[0]!.cycleId;
  }

  const id1 = await dispatchOnceOnAFreshGate();
  const id2 = await dispatchOnceOnAFreshGate();

  expect(id1).toMatch(/^\d+$/); // POSIX-ms numeric string, not "cycle-N"
  expect(id1).not.toBe("cycle-1"); // old per-gate format is gone
  expect(id2).not.toBe(id1); // no reset across gate re-creation → distinct per turn
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/env.sh && cd gateway && bun run test -- attention-gate --run -t "mints a unique POSIX-ms cycleId"`
Expected: FAIL — `id1` is `"cycle-1"` (matches the old format), so `expect(id1).not.toBe("cycle-1")` fails (and `id2` also `"cycle-1"`, so `id2 !== id1` fails).

- [ ] **Step 3: Write minimal implementation**

In `gateway/src/cerebrum/attention-gate.ts`, delete the `cycleCounter` declaration at line 116:

```ts
  let cycleCounter = 0;
```

…and replace `generateCycleId` (lines 131-134):

```ts
  function generateCycleId(): string {
    cycleCounter++;
    return `cycle-${cycleCounter}`;
  }
```

with:

```ts
  function generateCycleId(): string {
    // Server-authoritative, globally-unique per turn: a POSIX-millisecond id.
    // The old per-gate counter reset to 1 on every reconnect (a new gate per
    // session.configure), so two turns shared "cycle-1" and the client aliased
    // them onto one render row. A timestamp never collides across turns or gate
    // re-creations (turns are human-paced, far more than 1ms apart). cycleId is
    // cycle-meta only (live bubble, task pills); the client keys committed
    // history by entryId, never cycleId.
    return String(Date.now());
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source scripts/env.sh && cd gateway && bun run test -- attention-gate --run`
Expected: PASS — the new test passes and the existing AttentionGate tests stay green (none assert the `cycle-N` format).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/attention-gate.ts gateway/src/cerebrum/attention-gate.test.ts
git commit -m "fix(gateway): mint unique POSIX-ms cycleId per turn (no reset on reconnect)

Drop the per-gate cycleCounter that reset to cycle-1 on every
session.configure (i.e. every reconnect), aliasing turns on the client.
generateCycleId now returns String(Date.now()). cycleId stays cycle-meta
only; the client keys committed history by entryId.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Mobile SDK — dedup committed history by entryId

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/ConversationHistoryConnector.kt:175-192` (`onEntryFrame`)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/ConversationHistoryConnectorTest.kt` (append tests)

- [ ] **Step 1: Write the failing tests**

Append to `class ConversationHistoryConnectorTest { ... }`. The helpers `userItem`/`assistantItem`/`toolItem` and imports (`ConversationFeedItem`, `ServerMessage`, `kotlin.test.*`) already exist; `awaitingHistory` defaults to `false`, so a fresh connector accepts entries directly.

```kotlin
@Test
fun duplicate_entryId_replaces_in_place_not_appends() {
    val c = ConversationHistoryConnector()
    c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e1", ts = 2, content = "first")))
    assertEquals(1, c.items().size)
    // Same entryId re-delivered (e.g. a committed entry replayed on resume).
    c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e1", ts = 2, content = "first-updated")))
    assertEquals(1, c.items().size, "duplicate entryId must replace in place, not double-append")
    assertEquals("first-updated", (c.items()[0] as ConversationFeedItem.Assistant).content)
}

@Test
fun distinct_entryIds_still_append() {
    val c = ConversationHistoryConnector()
    c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e1", ts = 1, content = "a")))
    c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.Assistant(entryId = "e2", ts = 2, content = "b")))
    assertEquals(2, c.items().size)
}

@Test
fun empty_entryId_is_never_deduped() {
    val c = ConversationHistoryConnector()
    // entryId defaults to UNKNOWN_ENTRY_ID ("") — those have no identity, must not collapse.
    c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.User(ts = 1, channel = "text", content = "a")))
    c.handle(ServerMessage.ConversationEntry(ConversationFeedItem.User(ts = 2, channel = "text", content = "b")))
    assertEquals(2, c.items().size, "empty entryId must not collapse distinct entries")
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "*ConversationHistoryConnectorTest*"`
Expected: FAIL — `duplicate_entryId_replaces_in_place_not_appends` fails with `expected 1 but was 2` (the current `mirror = mirror + enriched` double-appends). The other two pass already.

- [ ] **Step 3: Write minimal implementation**

In `ConversationHistoryConnector.kt`, replace the body of `onEntryFrame` from the `mirror = mirror + enriched` line. The current code (lines ~184-191):

```kotlin
        val item = msg.item
        val enriched =
            if (item is ConversationFeedItem.Assistant && msg.cycleId != null) item.copy(cycleId = msg.cycleId)
            else item
        log.info("entry", mapOf("ts" to enriched.ts, "cycleId" to (msg.cycleId ?: "-"), "size" to mirror.size + 1))
        mirror = mirror + enriched
        onEntry?.invoke(enriched)
        onUpdate?.invoke(mirror)
```

becomes:

```kotlin
        val item = msg.item
        val enriched =
            if (item is ConversationFeedItem.Assistant && msg.cycleId != null) item.copy(cycleId = msg.cycleId)
            else item
        // Dedup by stable entryId: a re-delivered entry (e.g. a committed entry
        // replayed on resume) updates in place instead of double-appending.
        // Empty entryId (UNKNOWN_ENTRY_ID) has no identity → never deduped.
        val existingIdx =
            if (enriched.entryId.isNotEmpty()) mirror.indexOfFirst { it.entryId == enriched.entryId } else -1
        mirror =
            if (existingIdx >= 0) mirror.toMutableList().also { it[existingIdx] = enriched }
            else mirror + enriched
        log.info(
            "entry",
            mapOf(
                "entryId" to enriched.entryId,
                "ts" to enriched.ts,
                "cycleId" to (msg.cycleId ?: "-"),
                "deduped" to (existingIdx >= 0),
                "size" to mirror.size,
            ),
        )
        onEntry?.invoke(enriched)
        onUpdate?.invoke(mirror)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/env.sh && ./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "*ConversationHistoryConnectorTest*"`
Expected: PASS — all three new tests pass; existing connector tests stay green.

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/connectors/ConversationHistoryConnector.kt shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/connectors/ConversationHistoryConnectorTest.kt
git commit -m "fix(mobile-sdk): dedup committed history by entryId (replace-in-place)

onEntryFrame appended blindly; a committed entry replayed on resume
double-appended. Dedup by stable entryId (empty entryId never deduped).
Realises the specced-but-unimplemented dedup; history is now a clean
projection keyed by entryId.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Guard tests — the render keys are correct once cycleId is unique (no logic change)

These pin the invariants the server fix relies on. **No production code changes.** The tests pass against current code; they fail only if someone later breaks the invariant (e.g. re-introduces a colliding cycleId or over-broad suppression).

**Files:**
- Test: `ios/Tests/ChatRowsTests.swift` (append)
- Test: `shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCaseTest.kt` (append)

- [ ] **Step 1: Write the ChatRows guard tests**

Append to `struct ChatRowsTests { ... }` in `ios/Tests/ChatRowsTests.swift`. Note the local `msg(_:)` helper builds a `user` message with `cycleId: nil`; add a tiny assistant-with-cycle helper inline:

```swift
    private func assistantMsg(_ ts: Int64, cycleId: String?) -> ChatMessage {
        ChatMessage(ts: ts, role: "assistant", content: "x",
                    streaming: false, cutoffKind: nil, cycleId: cycleId, pendingId: nil, tools: [])
    }

    @Test func distinctCycleIdsProduceDistinctRowIds() {
        // With unique server cycleIds, two assistant turns never share a row id.
        let rows = chatRows([assistantMsg(1, cycleId: "1000"), assistantMsg(2, cycleId: "2000")], calendar: cal)
            .compactMap { row -> String? in if case .message = row { return row.id } else { return nil } }
        #expect(rows.count == 2)
        #expect(Set(rows).count == 2) // no alias
    }

    @Test func sameCycleIdAliasesRowId_documentsWhyServerMustBeUnique() {
        // Regression guard: a REUSED cycleId collides two turns onto one row id
        // (the original bug). The server fix guarantees cycleIds are unique.
        let rows = chatRows([assistantMsg(1, cycleId: "dup"), assistantMsg(2, cycleId: "dup")], calendar: cal)
            .compactMap { row -> String? in if case .message = row { return row.id } else { return nil } }
        #expect(rows.count == 2)
        #expect(Set(rows).count == 1) // alias — this is exactly what unique cycleId prevents
    }
```

- [ ] **Step 2: Write the ObserveChatUseCase guard test**

Append to `class ObserveChatUseCaseTest { ... }` in `shared/mobile-data/.../ObserveChatUseCaseTest.kt`. The `FakeConversationRepository`, `useCase`, and imports already exist; the existing `committed_twin_suppressed_while_live_same_cycle` test shows the pattern (`ChatModel.live?.cycleId`, `ChatModel.committed`).

```kotlin
@Test
fun prior_turn_is_not_suppressed_when_live_cycle_differs() = runTest(UnconfinedTestDispatcher()) {
    // With unique cycleIds, the live turn's id never matches a PRIOR turn's id,
    // so the suppression filter drops only the live turn's committed twin. (Under
    // the old reused-"cycle-1" bug, the prior turn's reply was wrongly suppressed.)
    val repo = FakeConversationRepository()
    repo.timelineState.value = listOf(
        ChatMessage(ts = 1, role = "user", content = "q1"),
        ChatMessage(ts = 2, role = "assistant", content = "answer-1", cycleId = "1000"), // prior turn
        ChatMessage(ts = 3, role = "user", content = "q2"),
    )
    val models = mutableListOf<ChatModel>()
    val job = launch { useCase(repo).invoke(MutableStateFlow(emptyList())).collect { models.add(it) } }
    repo.events.emit(SdkEvent.MessageStarted("2000")) // live = a DIFFERENT (later) turn
    repo.events.emit(SdkEvent.MessageDelta("2000", "answer-2"))
    runCurrent()
    val m = models.last()
    assertTrue(
        m.committed.any { it.cycleId == "1000" && it.content == "answer-1" },
        "the prior turn's reply must stay visible — only the live turn (2000) is suppressed",
    )
    assertEquals("2000", m.live?.cycleId)
    job.cancel()
}
```

- [ ] **Step 3: Run the guard tests**

Run (mobile-data): `source scripts/env.sh && ./gradlew :shared:mobile-data:testDebugUnitTest --tests "*ObserveChatUseCaseTest*"`
Expected: PASS (current code already satisfies the invariant — this is a characterization guard).

Run (iOS): `xcodebuild test -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SentientAppTests/ChatRowsTests` (generate the project first if needed: `./scripts/ios-setup.sh`).
Expected: PASS — both ChatRows guard tests pass.

- [ ] **Step 4: Commit**

```bash
git add ios/Tests/ChatRowsTests.swift shared/mobile-data/src/commonTest/kotlin/io/sentient/mobiledata/usecase/ObserveChatUseCaseTest.kt
git commit -m "test(mobile): guard cycleId-uniqueness invariants in render keys

Pin that distinct cycleIds → distinct ChatRows ids (no alias) and that
ObserveChatUseCase suppression drops only the live turn, never a prior
turn. No production change — these fail only if the unique-cycleId
invariant is later broken.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: E2E — run the matrix against the local stack

**Not a code task** — execution + evidence. Follow `.claude/rules/e2e-testing.md`: web → Playwright MCP; native iOS → Maestro; run against the local macOS Docker stack (`deploy/macos/`). Rebuild the gateway image from this branch first (the cycleId change is server-side) and rebuild the iOS app (the entryId-dedup change is in the KMP SDK).

- [ ] **Step 1: Build + boot the local stack from this branch**

```bash
source scripts/env.sh
docker compose -f deploy/macos/docker-compose.yml --profile build-only build
docker compose -f deploy/macos/docker-compose.yml up -d
```
Wait for `sentient-gateway` healthy + hermes orchestrated (poll `docker ps`). Confirm the gateway runs this branch's `attention-gate.ts` (cycleId = `Date.now()`).

- [ ] **Step 2: Run the web cases (Playwright MCP)**

From the spec's matrix — login Kevin / PIN 1234 at `https://localhost:8888`:
- **Two turns, no reconnect** (desktop 1280×900): send msg 1 → reply; send msg 2 → reply. Assert both replies render under their own messages. Verify the gateway log shows **two distinct numeric `cycleId`s** and each `conversation.entry` a distinct `entryId`.
- **Many-entry turn** (desktop + mobile 390×844): send a multi-tool message (e.g. daily briefing). Assert every entry renders as its own row; one `cycleId`, N distinct `entryId`s.
- **Stream→commit handoff**: send a message; assert the streaming bubble grows in place then commits with no flicker/duplicate.

Capture screenshots + console + the gateway `cycleId`/`entryId` log lines under the Playwright output dir.

- [ ] **Step 3: Run the iOS cases (Maestro)**

Build + install the app from this branch (`./scripts/ios-setup.sh` then run on a simulator, or `./scripts/build-ios.sh` for a device). Drive with Maestro:
- **Follow-up across reconnect (the repro)**: active chat with 1 completed turn → background/foreground to force a WS reconnect → send a follow-up. Assert the follow-up's reply renders correctly under the follow-up message; the previous response is NOT re-shown; nothing missing. Verify (logcat-equiv `os_log` / gateway log) the post-reconnect turn has a **different numeric `cycleId`** than the first.
- **Scroll stability**: chat with ≥2 turns incl. a long reply → scroll up past the latest reply, then back down. Assert the bottom reply stays visible + correct; row ids are `ent-<entryId>`/`cyc-<numericId>` (unique).

Capture Maestro output + simulator screenshots + the `os_log`/gateway log trail under the mobile QA dir.

- [ ] **Step 4: Record results**

Mark each matrix row green only when the user-visible behaviour AND the log trail match. Add the new reusable cases (reconnect-follow-up, many-entry-render) to `agents/docs/testing-knowledge.md`. Flag any case unreachable on the simulator (per the iOS E2E gaps in `.claude/rules/ios/ios-testing.md`).

---

## Notes for the implementer

- **No protocol schema change.** `cycleId` stays a `string` on the wire; only its value changes (`cycle-N` → ms string). web-sdk/webui need no change.
- **Versions:** bump gateway + mobile `+0.0.1` only at the end of the branch (after e2e), matching the project convention — not per task.
- **Pre-handover gate** (`.claude/rules/e2e-testing.md`): every matrix row green, evidence captured, lint + typecheck + unit tests clean (`bun run ci` for TS; gradle unit tests for KMP), deployable artifacts built.
