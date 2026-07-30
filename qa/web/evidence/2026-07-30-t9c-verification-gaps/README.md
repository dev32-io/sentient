# NM-T9c — verification gaps closed, and the two that stay open

Companion to `../2026-07-30-delegate-hermes-bg/`. Written by NM-T9c after fixing D8/D9/D7/D10.
Rows are recorded here exactly as they stand; nothing is flipped on partial evidence.

---

## Step 13 — stale BLOCKED headers corrected

`../2026-07-30-delegate-hermes-bg/README.md` opened `**Result: BLOCKED on two real product
defects**` while its own companion `RE-DRIVE-T9b.md` recorded PASS. A reader hitting the README
first got the wrong answer. Its header now says PASS, points at the re-drive, and marks the body as
the historical failing drive kept for its repro transcripts.

`.superpowers/sdd/progress.md` is append-only history, so its old BLOCKED lines were NOT rewritten
— rewriting them would falsify the record of what was true at the time. A dated correction block is
appended at the tail instead.

---

## Step 14 — `interrupt`'s background-cancel arm: primitive PROVEN, browser row NOT flipped

The arm is a four-link chain. Three links were already pinned by unit tests; the fourth — does a
cancel handle actually kill the real hermes **subprocess** — was not, and "the turn aborted" is not
evidence for it.

| Link | Status | Evidence |
|---|---|---|
| UI Stop -> `interrupt` -> `broker.background.cancelAll()` | pinned | `session-runtime.test.ts:801` (`cancelAllCalls === 1`), plus the contrast case at `:756` proving **barge-in never calls it** |
| `cancelAll()` -> every registered `cancel()` | pinned | `background-registry.test.ts:27`, incl. continuing past a throwing handle |
| `delegateTask`'s `cancel` -> `controller.abort()` | pinned | `delegate-task.ts:121` |
| abort -> `proc.kill()` -> **the OS subprocess is gone** | **PROVEN THIS TASK** | real-process run below |

Driven against the real `hermes` binary and the real `createHermesRunner` (no fake `spawn`), with a
long prompt so a task was genuinely in flight when the cancel landed:

```
[before] hermes pids for u_885ffeb7: []
[during] hermes pids: ["79522"]
[abort] firing cancel() -> controller.abort()
[result] {"ok":false,"error":"aborted"}
[after]  hermes pids: []
PASS: every hermes subprocess started by the run is gone after cancel
```

**The matrix row stays UNFLIPPED.** What fired the cancel here was `controller.abort()` — exactly
what `delegateTask`'s cancel handle does — not a click on the webui Stop button. The trigger link is
unit-pinned, not browser-driven, and this task could not obtain an authenticated WS/browser session
(see the blocker below). What is now closed is the substantive doubt T9b left: cancellation reaches
the subprocess. Whoever drives the browser row inherits a chain with no unproven link in it.

---

## Step 15 — `steer-followup-audio`: the AUDIO half remains unverified. NOT flipped.

T9b verified the **steer / new-bubble** half against the real model and it PASSES
(`RE-DRIVE-T9b.md`): a background completion resolving after the dispatching turn's final answer
started a genuine back-to-back turn, `trigger="background-completion"`, and the chain terminated
instead of running away.

The row's other assertion — *"audio queues behind the still-playing turn"* — is **NOT verified, and
must not be marked green on the text half.** Exact reason:

- T9b drove the row over the raw gateway WS seam (`auth` -> `session.configure` -> `text.input`,
  reading `turn.*` / `delegation.progress`). That driver never negotiates `audio.output`, so the
  gateway had no reason to open a TTS downlink and there was no audio queue to observe. The absence
  of audio frames there is a property of the harness, not of the product.
- Verifying it needs a client that actually negotiates `audio.output` and can observe playback
  ordering across two turns: a real browser (Playwright, with the composer + TTS enabled) or a
  Maestro-driven mobile app. Both need an authenticated session.

**Handoff to T11 / T10:** drive one delegated request that completes AFTER the dispatching turn's
final answer, with TTS on, and assert the follow-up turn's audio starts only after the first turn's
audio finishes. Mobile is the better surface — the KMP SDK's downlink is lazy-armed on `audio.start`
(see `project_mobile_stt_capture_and_filter_audit`), so ordering is observable there.

---

## The blocker both open rows share

Driving either row needs an authenticated session, and this task had no PIN for any of the three
local users (`Ada`, `Grace`, `Delegate Proof`). `POST /api/v1/admin/users` needs an admin PASETO
session token, which needs a PIN — circular. PIN guessing was not attempted.

One-line unblock for whoever holds a PIN, or can create a user through the wizard:

```bash
# then drive: auth -> session.configure {audio.output} -> text.input "ask hermes to …"
curl -sk https://127.0.0.1:8888/api/v1/auth/login -X POST \
  -H 'content-type: application/json' -d '{"userId":"<id>","pin":"<pin>"}'
```

This is an environment obstacle, not a product defect. Every product fault these rows were
originally blocked on is fixed and independently evidenced.
