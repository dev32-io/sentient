### Task 9f: D14 — restore the `pendingId` round trip; D13 — export the Android dialog's test ids

**Wave 6 · model: opus · both defects were masked by D12 and are now the visible truth**

Task 9e closed D12 and, in doing so, made the mobile send path real for the first time. Two defects underneath it are now reachable. Both are verified, both are outside 9e's ownership, both are filed in `docs/native-todo.md` § 1 with device evidence in `qa/mobile/evidence/2026-07-30-t9e-session-new/`.

They share one Android emulator, so they share one task. **D13 first** — it is one line and it unblocks a row you will want green while working on D14.

**Files:**
- Modify: `android/**` `chat/PermissionPromptDialog.kt` (D13)
- Modify: `gateway/src/store/schema.ts` + the store module (D14, `pending_id` column and its migration)
- Modify: the client projection that builds `conversation.entry` (D14, echo)
- Modify: the text-input path that commits a user entry (D14, dedupe)
- Test: the store's own tests, the projection tests, the text-input tests

Do **not** touch `shared/protocol/**` — `pendingId` is already at `shared/protocol/src/messages.ts:150`. The wire was never the problem.

---

## D13 — the Android permission dialog exports no test ids

- [ ] **Step 1: Confirm the mechanism, not just the symptom**

The dialog renders and works for a human. Both sides log it (`permission-request` on the gateway, `permission.pending.changed hasPending=true` in the app). But `uiautomator dump` while it is open shows **every node with `resource-id=""`**, so `id: chat-permission-allow` can never resolve.

`testTagsAsResourceId` is enabled once, on `android/.../nav/AppNavHost.kt:77`'s `Surface`. A Compose `AlertDialog` composes into **its own window**, outside that subtree, so the flag never reaches it.

```bash
grep -rn "testTagsAsResourceId" android/src | head
```
`android/.../settings/components/RowSelect.kt:87` already applies it locally to its dropdown for exactly this reason. That is the precedent — follow it.

- [ ] **Step 2: Fix, then prove it on the device**

One line: `Modifier.semantics { testTagsAsResourceId = true }` on the dialog's own root.

**Do not edit the flow.** Its ids are the ids in the source; they simply are not exported. Editing the flow to match a broken export is the failure mode this whole plan keeps catching.

```bash
./qa/mobile/run-e2e.sh android --tags chat
```
Expected: `12-permission-confirm` goes green **unedited**. iOS needs nothing — its twin already passes (SwiftUI alerts carry `accessibilityIdentifier` through), and that asymmetry is what makes this attribution evidence rather than a guess.

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(android): export the permission dialog's test ids" -- android/
```

---

## D14 — every mobile message is committed 2–6 times

- [ ] **Step 4: Read the history before designing anything**

This is **a regression of our own 2.0 legacy purge**, not a missing feature:

```bash
git log -S pendingId -- gateway/src | head -30
git show --stat 6c7bc1c    # feat: dedup text.input by pendingId (idempotent resend)
git show --stat aef5e0c    # the echo half
git show --stat 10bd446    # the 2.0 purge that removed both
```
Read what those two commits actually did before writing new code. You are restoring a contract that worked, on a different substrate — the store, which did not exist then. Restore the *contract*, not the old code shape.

The client half already assumes it. `OutboundCache.kt` states *"the gateway dedups by pendingId"* three times. Because it does not, the entry never reconciles, `ChatViewModel` re-runs `flushIfReady` on every `connection.state` emission, and the message re-sends — then gets swept to `FAILED`, showing a **Retry chip under a message that was delivered.** Measured 2× on a plain turn, 6× across a long one.

- [ ] **Step 5: The trap — `CREATE TABLE IF NOT EXISTS` is not a migration**

`gateway/src/store/schema.ts` has no migration mechanism at all: no `user_version`, no `ALTER TABLE`, no `PRAGMA table_info` check. Every existing per-user database under `~/.sentient/` **already exists**, so adding a column to the DDL changes nothing for any of them — and the first query naming `pending_id` fails at runtime, on real users only, never in a fresh-DB test.

Handle it deliberately. An idempotent `ALTER TABLE … ADD COLUMN` guarded by a `PRAGMA table_info` check is the smallest thing that works; a `user_version` migration ladder is the thing that keeps working when the next column arrives. **Pick one and say why.** Whichever you pick, write a test that opens a database created by the OLD DDL and proves it still opens and serves reads after the change — that is the case a fresh-DB test cannot see.

- [ ] **Step 6: Write the failing tests — three invariants, in this order**

```ts
it("STORE: an old database without pending_id opens and migrates in place", () => {
  // create with the pre-change DDL, then open through the real code path
});

it("WIRE: a committed user entry echoes the pendingId the client sent", async () => {
  // text.input{pendingId:"p1"} -> conversation.entry carrying pendingId "p1"
  // this is what lets the client reconcile; without it the outbox never settles
});

it("INVARIANT: the same pendingId is committed once, however many times it arrives", async () => {
  // send twice; the store holds ONE entry, and the second send still gets its echo
  // (a silent drop with no echo leaves the client retrying forever — worse than the bug)
});
```

That third parenthetical is the real subtlety: **a duplicate must still be answered**, just not committed twice. Dropping it silently swaps a visible duplicate for an invisible hang.

- [ ] **Step 7: Implement — restore the round trip, do not add a guard and call it done**

`native-todo.md` § 1 says this explicitly, and it is the D7 lesson from NM-T9c: there, the projection was the bug and a dedupe guard would have masked it. Here the round trip is genuinely missing — persist `pendingId` on the user entry, echo it on `conversation.entry`, and dedupe on it. All three, or the client still cannot reconcile.

Mind the projections: `render(replay) == render(live)` is a protocol-contract invariant. If the echo carries `pendingId` live, replay must carry it too, or a reconnect resurrects the duplicate the client just settled.

- [ ] **Step 8: Verify on the device — count rows, do not eyeball the screen**

```bash
./qa/mobile/run-e2e.sh android --tags chat,session
# then, against the live store for the driven user:
#   SELECT text, COUNT(*) FROM entries WHERE kind='user' GROUP BY text HAVING COUNT(*) > 1;
```
Expected: no duplicate rows, no Retry chip under a delivered message, `flush count=1` per send. 9e measured 2×/6× — measure again the same way, so the numbers are comparable.

- [ ] **Step 9: Update the record, then gate and commit**

Strike D13 and D14 from `docs/native-todo.md` § 1 — **only** what you actually closed. Update the `qa/mobile/` rows and `agents/docs/testing-knowledge.md`.

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
git commit -m "fix(store): restore the pendingId round trip so a resend is idempotent" -- \
  gateway/src/ qa/mobile/ agents/docs/testing-knowledge.md docs/native-todo.md
```
Expected: ≥1142 pass.

- [ ] **Step 10: Re-drive what D14 was polluting**

`steer-followup-audio`, `reload-convergence` and `restart-persistence` are unblocked but were deliberately not re-driven by 9e, because anything reading the store or the model window was reading polluted data. With D14 closed they are readable. Drive them; report each PASS-with-evidence, FAIL-with-evidence, or handed to T11 with the reason.

Leave `01-newchat` red — it is D15's standing acceptance test and D15 is deferred to the multi-conversation project on purpose. Do not edit it to pass.
