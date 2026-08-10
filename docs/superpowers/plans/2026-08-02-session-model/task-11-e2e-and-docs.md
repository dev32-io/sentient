### Task 11: drive the matrix, and leave no document saying the old thing

**Spec:** §10. **Model:** opus — this is the exit gate for the whole wave.

**Files:**
- Create: `qa/web/evidence/<date>-session-model/README.md` + screenshots + log excerpts
- Modify: `agents/docs/testing-knowledge.md` (new reusable cases)
- Modify: `docs/native-todo.md` (strike D15; record what stays open)
- Verify: `CLAUDE.md` and 2.0 design §2.6 were updated by task 5

---

**Standing constraints.** Local dev stack only — `http://localhost:5173`, never `mini0.lan` / `sentient.dev32.io`. Credentials from `agents/docs/testing-knowledge.md`. Tool calls are **reads or temp-writes only**: no `ha_call_service`, no `ma_playback` / `ma_play_media` / `ma_volume`. Never a broad `pkill`.

**Pre-flight, every session:** `bun qa/web/stack-integrity.ts` → `RESULT PASS`. A row driven against a degraded stack proves nothing.

---

- [ ] **Step 1: Write each row's oracle BEFORE driving it**

This branch has shipped four false greens, every one because the oracle could not fail: a stack read "ready" while both addons were dead and a day-old orphan answered the probe; a tool row passed while its own evidence read `isError=true`; a 390 px overflow check passed because an ancestor's `overflow: hidden` suppressed the scroll it looked for.

So for each row: state the oracle, drive it, then ask **"could this oracle still have failed?"** If not, the row proved nothing — say so in the evidence rather than counting it.

Two specific traps this matrix will hit:
- **Never accept the model's self-report.** A round-2 driver asked whether the model had prior context *while offering an escape hatch*; it claimed `NO-CONTEXT` while the wire showed the full transcript. Check `stream-start messageCount`, and re-ask without a hatch.
- **Never use page-level `scrollWidth <= innerWidth`** to check for clipping. Walk the ancestor chain comparing each element's `scrollWidth` to its `clientWidth`.

- [ ] **Step 2: Drive the matrix**

All rows from spec §10. Group them so the browser is driven once per group rather than once per row.

The five `security`-tagged rows — `unknown-session-refused`, `cross-user-refused`, `wrong-capability-refused`, `expired-credential-refused`, and the `userId`-in-request check from task 4 — must be **driven**, not reasoned about. `wrong-capability-refused` is a unit test; the rest are live.

- [ ] **Step 3: The rows that need two windows**

`two-windows-live`, `two-windows-steer`, `two-windows-race`, `join-midturn`, `join-race`, `permission-either-answers`, `permission-issuer-leaves`, `stop-from-either`, `connection-lane-private`, `last-one-out`, `reload-convergence`.

`connection-lane-private` is the privacy row and needs more than one frame type: force a resume **and** a ping **and** an auth refresh on window A, then assert **none** of them appear at B.

- [ ] **Step 4: The rows that need patience**

`retention-holds-work` — start a delegated task, close every window, reattach after it finishes. `retention-drops-idle` — close all, wait past `session.retention_ms`, reattach. `retention-timer-race` is `fault-armed`: it needs timing injection rather than wall-clock luck, so drive it as a harness test and say so.

- [ ] **Step 5: Hand the owner what a browser cannot reach**

`bargein-cutoff` needs a real microphone: speak over TTS and confirm `cutoff="barge-in"` with background tasks left running (that is the distinction from Stop). Write it into the handoff with the exact log line to grep, not as a vague "test voice".

`voice-roundtrip` remains outstanding from round 2 and belongs in the same handoff.

- [ ] **Step 6: Strike what is closed; keep what is not**

`docs/native-todo.md`: strike **D15** using the file's `~~D15 — …~~ — CLOSED <date> (plan task N)` convention, keeping the original symptom text as the record of what was true.

Do **not** strike: the delegated-task silence (D16), the untrusted-content boundary, durable turn state and tool idempotency, or symlink-safe capability paths. If this wave's work changed the shape of any of them, append a dated note rather than editing the original.

- [ ] **Step 7: Add the reusable cases to the library**

`agents/docs/testing-knowledge.md` gains the multi-window cases — they are reusable across mobile and web and are the first cases in this repo that need **two clients on one session**. Give them real tags from the taxonomy so `run-e2e.sh --tags` can address them.

- [ ] **Step 8: Confirm no document still describes the old model**

Task 5 was supposed to update `CLAUDE.md` and 2.0 design §2.6. Verify it did:

```bash
grep -rn "userId, surfaceId" CLAUDE.md docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md
grep -rn "one per (userId" CLAUDE.md
```

A stale line here is not cosmetic. This branch has three recorded instances of documentation asserting something untrue — `delegateTask`'s "would double-prompt", `mcp-policy.yaml`'s claimed injection scan, and `CLAUDE.md`'s capability claim — and each survived review because a reader trusted the comment.

- [ ] **Step 9: Final gate**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
(cd gateway/webui && bun run test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```

Expected: clean typecheck and lint, no failing tests, `RESULT PASS`.

- [ ] **Step 10: Report honestly**

The evidence README states, per row: PASS / FAIL / BLOCKED, the oracle used, and — for anything green — whether that oracle could still have failed. A row you could not drive is BLOCKED with the reason. Never a quiet PASS.
