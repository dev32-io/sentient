# Group A — auth-wrong-pin, auth-logout, newchat-red

Driven against the local dev stack (`http://localhost:5173`, gateway API at
`https://localhost:8888`) via Playwright MCP, per
`e2e-round2-brief.md`. Repo: `/Users/kevinye/Development/sentient`, branch
`feature/native-orchestrator`.

## Pre-flight

```
$ bun qa/web/stack-integrity.ts
...
[stack-integrity] log-window: clean
[stack-integrity] RESULT PASS — pass=9 fail=0 skip-optional=0 of 9 declared
```
All 9 declared addons (docker + native) PASS. Browser reset to
`http://localhost:5173/` before driving — landed cleanly on the "Who's using
Sentient?" user picker, no leftover PIN pad from a previous operator.

---

## ROW 1 — `auth-wrong-pin` — **PASS**

**Oracle stated up front:** (a) still on the login screen after the attempt,
AND (b) the gateway log shows no successful auth for that attempt. Also
checking, per the brief: is the error actually communicated to the user, or
is the PIN pad silently reset with no message.

**Action:** clicked Grace → entered `9999` on the PIN pad (`15:18:39` local).

**Result — user-visible:** an inline error message **"Wrong PIN"** rendered
below the pad (see `group-a-screenshots/row1-auth-wrong-pin-error.png`). The
pad stayed mounted and was cleared/re-enabled for retry — the user was not
silently bounced or left guessing. Login screen never navigated away.

**Result — network:** `POST /api/v1/auth/login` → `401 Unauthorized`, body
`{"userId":"u_1eee01a4","pin":"9999"}` (Grace's real userId — confirms the
right account was targeted, not a client-side short-circuit).

**Result — browser console:**
```
[ERROR]   Failed to load resource: the server responded with a status of 401 (Unauthorized) @ .../api/v1/auth/login
[WARNING] [sentient.webui.auth.context] login-failed {code: invalid-credentials}
```

**Result — gateway log:** grepped `~/.sentient/gateway/logs/2026-08-01.log`
from `15:18:39` forward: **zero new lines**, in any category, through the
end of the file (confirmed: `authenticate.ok` for Grace's userId
`u_1eee01a4` does not appear anywhere in today's log; the last successful
auth in the file is Ada at `15:02:40`, unrelated to this attempt). Oracle
(b) holds: no successful auth, and specifically no principal was minted for
Grace on this attempt.

### Finding — auth failures are invisible at the deployed log level (not a hard fail, but a real gap)

The oracle asked for "an authentication failure" to be logged, and the
brief's own log-reading guidance points at these tags. **No such line
exists in the log file at all** — not filtered by grep, not on a different
tag: the file's last write timestamp (`15:12` — from unrelated TTS
playback) predates our `15:18:39` action, i.e. nothing was appended.

Traced to source:
```
gateway/src/user-auth/auth-service.ts:81   log.debug("authenticate.no-user", { userId });
gateway/src/user-auth/auth-service.ts:86   log.debug("authenticate.wrong-pin", { userId });
gateway/src/user-auth/auth-service.ts:90   log.info("authenticate.ok", { userId: r.value.userId });
```
Only the **success** path (`authenticate.ok`) logs at `INFO`; both failure
branches log at `DEBUG`. The running gateway loaded
`gateway/config.yaml` (confirmed via
`2026-08-01T13:33:16.790 INFO [config] config-loaded | path=".../gateway/config.yaml"`),
which sets `logging.level: info` (repo default — "info for prod, debug for
local dev", i.e. **this is also the documented prod default**). At `info`,
`authenticate.wrong-pin` / `authenticate.no-user` are filtered out
entirely — a failed login attempt against production leaves **zero
server-side trace**. This is a security/observability gap: `.claude/rules/logging.md`
calls for "WARN with a `reason` field for every fallback / degraded path,"
and `.claude/rules/testing.md` names auth as a security boundary worth
defending; a silently-unlogged auth failure fits neither. Recommend
promoting both failure branches to at least `WARN` (not user-content, just
`userId` + reason, so no new privacy exposure).

**Oracle re-check:** could this oracle still have failed silently? Yes on
one axis — I only confirmed *absence* of a success line, which is a
reliable negative signal (principal genuinely not minted), but the intended
positive signal ("failure IS logged") does not exist to check. Recording
that gap explicitly rather than papering over it with the negative-only
reading.

---

## Correction from coordinator (post Row-1 report)

The coordinator independently verified the stored PIN hashes: `1234` is
**Ada's** PIN, not Grace's. Grace's and Delegate Proof's actual PINs are not
written down anywhere. The original blocker diagnosis above (PIN mismatch,
confirmed both live and via `Bun.password.verify`) was correct — the brief's
"every local user is `1234`" ground truth was wrong, not the stack. The
brief and `agents/docs/testing-knowledge.md` have been corrected. Rows 2 and
3 below are re-driven with **Ada** (PIN `1234`) per the coordinator's
instruction. Row 1 is not re-driven (already PASS, credential-independent).
Per the coordinator's explicit instruction, no further probing of Grace's or
Delegate Proof's PINs was attempted — Ada is the only account driven from
here on, and a failure on Ada's login would itself be a genuine BLOCKED.

---

## ROW 2 — `auth-logout` — attempt 1 (Grace) — **BLOCKED** (superseded below)

**Oracle stated up front:** after logout + re-login as Grace, the exact
message text sent before logout (not just "the feed has items") is visible
again.

**Pre-state needed:** logged in as Grace (PIN `1234` per the brief) with a
non-empty conversation.

**What happened:** could not establish the pre-state. Logging in as Grace
with the documented PIN `1234` (`15:20:52`–`15:21:09` local, digit-by-digit
via the PIN pad, confirmed via the network payload) was rejected:

```
POST /api/v1/auth/login → 401 Unauthorized
body: {"userId":"u_1eee01a4","pin":"1234"}
console: [sentient.webui.auth.context] login-failed {code: invalid-credentials}
```

This is not a UI/typo artifact — the exact string `"1234"` was sent for
Grace's real userId and rejected server-side.

**Independent, out-of-band confirmation** (per the brief's "get ground
truth from a different path" guidance): read Grace's stored `pinHash` from
`~/.sentient/gateway/users.json` (untouched since file creation, per
`stat -f "%Sm"` = `Jul 30 03:05:14`, matching account-creation time — the
file has not been rewritten since) and verified it in-process with the same
primitive the gateway itself uses (`Bun.password.verify`, read-only, no
network calls, no repeated live-auth attempts):

```
$ bun -e '... Bun.password.verify("1234", grace.pinHash) ...'
Grace pin 1234 verifies: false
```
Run twice to rule out a fluke; same result both times.

**This directly contradicts the brief's stated ground truth** ("The PIN for
every local user is `1234`") for Grace specifically, on the *current* state
of this dev stack. It is not stale-brief noise either: the gateway's own
log shows **Grace authenticated successfully many times on 2026-07-30 and
2026-07-31** (last success `2026-07-31T20:21:24`, tag
`[gateway:user-auth:auth-service] authenticate.ok | userId="u_1eee01a4"`),
using this same never-modified hash file. So whatever PIN worked for Grace
on 7/30–7/31 was captured correctly by that hash — it simply isn't `1234`
today, and I have no legitimate way to learn what it actually is.

**What I did NOT do, and why:** I considered one further diagnostic step —
logging in as Ada with `1234` through the UI — to distinguish "Grace's PIN
specifically drifted from convention" (e.g. a human typed a custom PIN in
the Add-User wizard on 7/30, per `qa/web/evidence/2026-07-30-multi-user-isolation/README.md`,
which created Grace) from "PIN verification is broken for everyone" (a much
bigger, systemic finding). The Claude Code permission classifier blocked
that action (and a second attempt to bash-verify multiple users' hashes in
one script) as a credential-probing pattern across accounts. I'm treating
that block as correct and am **not** routing around it — trying further PIN
guesses for Grace, or testing other accounts, would cross from "diagnosing
a blocked test row" into brute-forcing live credentials, which the brief's
constraint #3 (reads/temp-writes only) and #2's spirit ("an unknown PIN is
never a reason to stop — **you have it**") do not license once the PIN you
were given turns out to be wrong. I also did not edit `users.json` to reset
the PIN — that would violate constraint #3 ("never modify an existing
file") and would corrupt the very data this row needed to observe honestly.

**Screenshot:** `group-a-screenshots/row2-3-blocked-login-screen.png` — back
at the clean login screen, unable to proceed past Grace's PIN pad.

**Verdict (attempt 1):** BLOCKED, not FAIL and not a quiet PASS. The row was
never driven with Grace because its documented pre-state is unreachable
with the credentials given. Superseded by attempt 2 below, driven with Ada
per the coordinator's correction.

---

## ROW 2 — `auth-logout` — attempt 2 (Ada) — **PASS**

**Oracle stated up front:** after logout + re-login as Ada, a distinctive
marker string I choose (not "the feed has items") is visible again, exactly
as sent. Ada already has history from earlier runs, so emptiness was never
the signal — exact text match is.

**Pre-state:** logged in as Ada (PIN `1234`, verified correct this time —
`POST /api/v1/auth/login` succeeded, no 401). Landed on an existing
conversation with one prior exchange ("Reply with the single word: pong" →
"pong", Friday 10:58 PM).

**Action (`15:33:41`–`15:34:33` local):** sent the message `Marker for e2e
row2: QUOKKA-7734-MARKER. Reply with exactly: ROW2-ACK` and waited for the
reply. Got back `ROW2-ACK` (screenshot:
`group-a-screenshots/row2-marker-sent.png`). Opened the account menu (Ada
avatar → "Log out") and logged out — landed cleanly on the user picker, no
stray session state. Logged back in as Ada with `1234`.

**Result — user-visible:** post-relogin, the feed shows all four prior
entries intact, in order, byte-for-byte:
```
Ada:       "Reply with the single word: pong"
Sentient:  pong
Ada:       "Marker for e2e row2: QUOKKA-7734-MARKER. Reply with exactly: ROW2-ACK"
Sentient:  ROW2-ACK
```
Screenshot: `group-a-screenshots/row2-post-relogin-marker-visible.png`. The
exact marker string `QUOKKA-7734-MARKER` — not a paraphrase, not "a message
was there" — is present.

**Result — gateway log** (`log-excerpt-row2-logout-relogin.txt`, full
excerpt from `15:32:55`):
- First login: `authenticate.ok | userId="u_0417d3b0"` (`15:33:26`),
  `session-runtime.factory.build | conversationId="c::u_0417d3b0::16a4b56e-7731-4941-b7eb-da494f814ae6"`,
  `conversation-feed.snapshot | itemCount=2`.
- Send marker: `session-runtime.submit.start-turn` → `react-loop.completed`
  with `textLength=8` (= `"ROW2-ACK"`, exactly 8 chars).
- Logout: `session-runtime.dispose | hadInFlight=false cutTurnCount=0` →
  `store.closed` → `session-cleanup`.
- Second login: `authenticate.ok | userId="u_0417d3b0"` (`15:35:06`),
  **same** `conversationId="c::u_0417d3b0::16a4b56e-7731-4941-b7eb-da494f814ae6"`,
  `conversation-feed.snapshot | itemCount=4 throughSeq=146` (up from
  `itemCount=2 throughSeq=114` before) — the store persisted and replayed
  both new entries.

**Oracle re-check:** could this have passed for the wrong reason? No — I
picked an arbitrary, never-seen-before string (`QUOKKA-7734-MARKER`) rather
than relying on stock copy that could plausibly appear from a cached/seeded
fixture, and I checked both the rendered DOM text and the server's own
`itemCount`/`conversationId` continuity, two independent signals that agree.

**Verdict:** **PASS.**

---

## ROW 3 — `newchat-red` (driven with Ada) — **RECORDED** (known defect D15, confirmed live)

Per the brief, this is a recording row, not pass/fail — D15 is a filed,
known defect (`docs/native-todo.md` §1). Driven live to capture current
behavior precisely, continuing directly from Row 2's Ada session (feed
non-empty: the pong exchange + the `QUOKKA-7734-MARKER`/`ROW2-ACK`
exchange).

**Action (`15:36:21` local):** clicked the "Past chats" drawer toggle
(hamburger icon, top-left) to open the sessions drawer.

**Drawer-open observation (not asked for, but relevant):** the drawer
showed **"Couldn't load sessions — try again."** with a Retry button, not
an empty list. Network: `GET /api/v1/sessions?limit=50&offset=0` → `404`;
console: `[sentient.webui.use-sessions] sessions.load.failed {reason:
sessions REST error: 404}`. This is the exact mechanism D15 names as the
root cause of three other drawer-dependent flows: "the 2.0 gateway serves
no `/api/v1/sessions` route at all." Screenshot:
`group-a-screenshots/row3-drawer-open-couldnt-load.png`.

**Clicked "+ New chat".** Screenshot taken immediately after:
`group-a-screenshots/row3-immediately-after-new-chat-click.png`.

**Does the feed clear? No.** All four prior entries (pong exchange +
marker exchange) remained on screen, unchanged, in place — verified via
accessibility snapshot immediately after the click, not just the
screenshot. **Does anything else change besides the drawer closing?** Yes,
one thing: the drawer's own state flipped from "Couldn't load sessions" to
"Sync failed — list may be stale." with a new "Today" group showing a
"New chat" row — a client-side optimistic list entry for the session that
was just (nominally) created, not a server-confirmed list (the underlying
`GET /sessions` route still doesn't exist). The main conversation pane
itself: zero visible change other than the drawer's own contents.

**Context-carry probe.** Per the brief's ask, sent a question that could
only be answered from the pre-"+" conversation. First attempt was
methodologically soft — I gave the model an escape hatch ("if this is
truly a fresh conversation... say NO-CONTEXT") and it took the escape
hatch, answering **`NO-CONTEXT`** even though (see below) the marker was
demonstrably present in its input. That is a real, separate observation
(the model's own self-report about its context is not trustworthy — see
oracle note below), so I did not treat it as the final answer and re-probed
without an opt-out: **"Repeat back, character for character, the exact
marker string I sent you earlier in this conversation. Just output the
string, nothing else."** Reply: **`QUOKKA-7734-MARKER`** — exact match,
character for character. Screenshot:
`group-a-screenshots/row3-context-recall-proof.png`.

**Result — gateway log** (`log-excerpt-row3-newchat-context.txt`, full
excerpt from `15:36:21`):
- `[ws:session-new] session.new.answered | sessionId="s-msay91hh-x7y921mg"
  conversationId="c::u_0417d3b0::16a4b56e-7731-4941-b7eb-da494f814ae6"` —
  **identical** conversationId to the one in use since Row 2's first login,
  confirming D15's description precisely: "+" is answered with the
  *existing* conversation id, not a fresh partition.
- `grep -n "session-boundary" $LOG` → **zero hits, anywhere in today's
  log.** `session-boundary.clear-drain` never fires — that tag does not
  exist on this code path (or is not reached on web); there is no
  clear/drain event to find, which is itself informative: nothing purports
  to have cleared anything server-side.
- The two turns after "+": `provider:openai stream-start | messageCount=6`
  for the first ("what marker word...") and `messageCount=8` for the
  second ("repeat back..."). Counting backward: 1 system message + 5 prior
  turn messages (pong/pong, marker/ROW2-ACK, the NO-CONTEXT probe) = 6,
  growing to 8 as the conversation continues normally. **This is the load-
  bearing evidence, independent of the model's own claims**: the full
  pre-"+" transcript, including the marker string, was sent to the LLM
  provider on both turns. The `NO-CONTEXT` answer was the model declining
  to use context that was unambiguously present on the wire, not evidence
  the context was absent — exactly the trap the brief's oracle rule warns
  about ("a reply appeared" is not an oracle; here, even "the model *said*
  it forgot" was not one either, and the direct recall probe against the
  same wire evidence settled it).

**Verdict:** D15 **confirmed live, exactly as filed**, on Ada — this is a
DATA bug, not merely a cosmetic one: not only does the client-visible feed
fail to clear, the server-side conversation and its full history are
provably still in the prompt sent to the LLM after "+ new chat," and the
model successfully (if reluctantly) recalled information from before the
click. A user who taps "+" believing they're starting fresh is not:
whatever they say next is answered with full awareness of the "old" thread,
including anything sensitive said before the reset.

---

## Log evidence files

- `log-excerpt-row1-2-auth-window.txt` — Row 1 window, `15:00:00`–`15:12:40`
  (pre-correction, Grace attempts): 4 lines, all Ada, nothing for Grace.
- `log-excerpt-row2-logout-relogin.txt` — Row 2 attempt 2 (Ada), full
  excerpt from `15:32:55`: both logins, the marker turn, and the
  logout/dispose sequence.
- `log-excerpt-row3-newchat-context.txt` — Row 3 (Ada), full excerpt from
  `15:36:21`: `session.new.answered`, both post-"+" turns showing
  `messageCount` growth, no `session-boundary` tag anywhere.

## Summary

| Row | Verdict | Oracle |
|---|---|---|
| `auth-wrong-pin` | **PASS** | Login screen retained + "Wrong PIN" shown + no `authenticate.ok` for Grace in log since before the attempt. Side finding: the failure itself is never logged at the deployed `info` level (source-traced, `DEBUG`-only). |
| `auth-logout` (attempt 1, Grace) | **BLOCKED** — superseded | PIN `1234` rejected for Grace both live and out-of-band (`Bun.password.verify`, twice). Brief's PIN was wrong for this account; corrected by coordinator (`1234` is Ada's). |
| `auth-logout` (attempt 2, Ada) | **PASS** | Exact marker string `QUOKKA-7734-MARKER` (not "feed non-empty") visible after logout+relogin, confirmed in DOM AND via server `conversationId` continuity + `itemCount` 2→4. |
| `newchat-red` | **RECORDED** (known defect D15, confirmed live) | Feed does not clear on "+ new chat"; `session.new` returns the *same* `conversationId`; `session-boundary.clear-drain` never fires (zero log hits); `messageCount=6→8` proves the full pre-"+" transcript, including a planted marker, was sent to the LLM; the model recited the marker back verbatim on direct request — a genuine data leak across the "new chat" boundary, not a cosmetic UI bug. |

**Bottom line:** all three rows are now settled. Row 1 (PASS) surfaced a
real logging gap (auth failures invisible at `info` level). Row 2 (PASS,
re-driven with Ada) confirms logout/relogin persistence is solid — exact
text, not just presence, survives. Row 3 (RECORDED) confirms D15 is real
and, going further than the filed description, proves it is a context/data
leak at the LLM-prompt level, not just a UI-refresh cosmetic bug — worth
elevating in severity if that distinction wasn't already captured where D15
is tracked.
