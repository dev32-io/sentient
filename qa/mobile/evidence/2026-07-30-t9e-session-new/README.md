# D12 closed — `session.new` answered; three defects it was masking (2026-07-30, plan task 9e)

Driven against the local dev stack: native gateway `bun --hot src/main.ts` on `:8888`, docker addons
on loopback, native whisper-stt `:8768` + local-tts `:8770` both listening. Devices: Android
`emulator-5554` and iOS sim `iPhone 17 / iOS 26.5` (`43FC67B5-6A96-4EE7-A23B-778C8849D23F`) — the
same pair NM-T10 used. Provider: `gpt-oss:20b-cloud` via Ollama Cloud (free tier).

Never prod. Nothing here was driven against `mini0.lan` / `sentient.dev32.io`.

---

## D12 — CLOSED

`gateway/src/session-handlers/ws-session-new.ts` answers `session.new` with `session.created`
naming this connection's durable conversation id. The chain NM-T10 measured as broken is now
complete end to end:

Gateway (`gateway-session-new-answered.txt`):
```
INFO [ws]              session-opened        | sessionId="s-ms7t6e1b-d6e2x7i3"
INFO [ws-auth-gate]    auth.ok               | userId="u_0417d3b0"
INFO [ws:session-new]  session.new.answered  | requestId="-77c36405019e0eee"
                                               conversationId="c::u_0417d3b0::8e0a4b02-…"
INFO [runtime:session-runtime] session-runtime.submit.start-turn | …
INFO [runtime:react-loop]      react-loop.start | …
INFO [ws:turn-emitter]         turn-emitter.turn-completed | …
```

Device (`android-logcat-outbox-drains.txt`) — the exact line NM-T10 captured as
`flush-skipped reason=no-id-attached` is now:
```
sentient.mobile-sdk.data.send-message: flush count=1 sessionId=c::u_0417d3b0::8e0a4b02-…
```
`no-id-attached` no longer appears anywhere in the drive.

### Batch results — flows UNCHANGED (no flow was edited to make anything pass)

`./qa/mobile/run-e2e.sh android --tags chat` → **5/6 pass** (was 0/6, all D12):

| Flow | Before (NM-T10) | Now |
|---|---|---|
| `verify-newchat` | FAIL (D12) | **PASS** 20s |
| `01-chat-send` | FAIL (D12) | **PASS** 17s |
| `01-send-stream` | FAIL (D12) | **PASS** 17s |
| `03-new-chat` | FAIL (D12) | **PASS** 10s |
| `05-interrupt` | → Task 11 (D12 + TTS gate) | **PASS** 27s |
| `12-permission-confirm` | FAIL (D12) | FAIL — **D13**, not D12 |

`./qa/mobile/run-e2e.sh ios --tags chat` → **4/5 pass** (was 0/5):

| Flow | Before (NM-T10) | Now |
|---|---|---|
| `01-send-stream` | FAIL (D12) | **PASS** 31s |
| `03-new-chat` | FAIL (D12) | **PASS** 12s |
| `05-interrupt` | → Task 11 | **PASS** 41s |
| `12-permission-confirm` | FAIL (D12) | **PASS** 30s |
| `01-newchat` | FAIL (D12) | FAIL — **D15**, not D12 |

`permission-confirm` passing on iOS and failing on Android is the load-bearing datum: it proves the
gateway's whole L3 round-trip works from a device (`permission-request` →
`permission-resolved outcome="allowed"` at 10:59:32) and localises the Android red to the client.

---

## D13 (NEW) — the Android permission dialog exports no test ids to UIAutomator

**Not a product bug for a human; a total blocker for Maestro.** The dialog renders correctly — title,
tool name, reason, a live "Expires in 1:36" countdown, Deny/Allow (screenshot taken during the drive;
`*.png` is gitignored repo-wide, `.gitignore:82`, so the flattened hierarchy dump below is the
committed artifact). The gateway sent it and the app received it:

```
gateway  INFO [ws:turn-emitter] turn-emitter.permission-request | requestId="ede4b7ad-…" toolName="ha_call_service"
device   I connector.permission:  request requestId=ede4b7ad-… toolName=ha_call_service open=1
device   I android.chat-viewmodel: permission.pending.changed hasPending=true toolName=ha_call_service open=1
```

But `uiautomator dump` while the dialog is up (`android-permission-dialog-hierarchy.txt`) shows
**every node with `resource-id=""`**:
```
class=android.widget.TextView  resource-id=""  text="Allow this action?"
class=android.widget.TextView  resource-id=""  text="ha_call_service"
class=android.view.View        resource-id=""  text=""              bounds=[749,1308][914,1440]
class=android.widget.TextView  resource-id=""  text="Allow"
```
So `assertVisible: id: chat-permission-allow` can never be true, and the 40 s budget is irrelevant.

**Cause.** `testTagsAsResourceId` is enabled once, on the `Surface` at
`android/src/main/kotlin/io/sentient/android/nav/AppNavHost.kt:77`. A Compose `AlertDialog` composes
into its **own window**, outside that Surface's subtree, so the flag never reaches
`PermissionPromptDialog.kt`'s `testTag("chat-permission-allow")`.

The codebase already knows this exact trap — `android/src/main/kotlin/io/sentient/android/settings/components/RowSelect.kt:87`
carries the comment *"the app-root testTagsAsResourceId does NOT reach it, so re-enable it here"*
and applies `Modifier.semantics { testTagsAsResourceId = true }` locally for its dropdown.
`PermissionPromptDialog` never got the same treatment.

**Fix (one line, `android/**` — outside task 9e's ownership):** apply
`Modifier.semantics { testTagsAsResourceId = true }` inside `PermissionPromptDialog`, exactly as
`RowSelect` does. **Do not "fix" the flow** — its ids are the ids in the source; they are simply not
exported. iOS needs nothing (SwiftUI alerts carry `accessibilityIdentifier` through, which is why
the twin passes).

---

## D14 (NEW, highest impact) — every mobile message is written to the store 2–6 times

The optimistic outbox's whole contract is *"the gateway dedups by pendingId"* — stated three times
in `shared/mobile-data/.../outbox/OutboundCache.kt` (class header, `enqueue`, `queued`). **The 2.0
gateway does not.** `pendingId` is in the wire schema (`shared/protocol/src/messages.ts:150`) and
`grep -rn "pendingId" gateway/src --include='*.ts' | grep -v test` returns **zero** hits. The
`entries` table has no `pending_id` column at all, so the committed echo cannot carry one even in
principle.

Consequence chain:
1. `OutboundCache` keeps an entry `QUEUED` until its committed echo reconciles it by pendingId.
2. No echo ever carries a pendingId → the entry is never removed.
3. `ChatViewModel` re-runs `flushIfReady` on **every** `connection.state` emission (status,
   `isSpeaking`, …) and `queued()` still returns the entry → re-send.
4. After `unackedTimeoutMs` the entry is swept to `FAILED` → a **Retry chip under a message that
   was delivered** (observed on screen during the drive).

Measured (`store-duplicate-user-entries.txt`), one Android `chat` batch:
```
100|user|what is 2 plus 2
101|user|what is 2 plus 2
102|user|tell me a very long story about the hist
103|user|tell me a very long story about the hist
104|user|turn on the kitchen light
105|user|turn on the kitchen light
...
110|user|turn on the kitchen light
111|user|turn on the kitchen light
```
Five client sends of one message were observed in a 165 ms burst
(`data.send-message: flush count=1` ×5 at 10:51:38) against gateway
`session-runtime.submit.steer seq=107,108,110,111`.

**This is a regression of the 2.0 legacy purge, not of task 9e.** `git log -S pendingId -- gateway/src`
shows the mechanism existed and was deleted with the Hermes brain:
```
6c7bc1c feat(gateway): dedup text.input by pendingId (idempotent resend)
aef5e0c feat(gateway): thread client pendingId onto user conversation feed echo
10bd446 refactor(gateway)!: purge Hermes-runtime brain …      <-- removed both
```
It was invisible while D12 blocked every send. Fixing D12 unmasked it.

**Do not "fix" this with a dedupe guard in the router.** The same mistake was made and caught in
NM-T9c (D7): the projection was the bug and a guard would have masked it. The correct fix is to
restore the round trip — persist `pendingId` on the user entry and echo it on
`conversation.entry` — which touches the store schema and both projections, i.e. several
task-ownership boundaries.

---

## D15 (NEW) — "+ new chat" does not reset the server-side conversation

`ios/01-newchat.yaml` taps "+", sends `what is 8 plus 9`, and waits for an assistant bubble. It
FAILS, and the trail says why: the model answered by calling `ha_call_service` again —

```
10:59:32  turn-emitter.permission-resolved  outcome="allowed"        (previous flow's HA call)
10:59:55  session-runtime.submit.start-turn turnId="464754ad-…"      ("what is 8 plus 9")
11:00:03  stream-end  finishReason="tool_calls"  promptTokens=10272
11:00:03  turn-emitter.permission-request   toolName="ha_call_service"
```
— so the turn parked on a permission prompt instead of answering "17", and no assistant bubble
arrived inside 60 s.

That is the **stated, accepted cost** of how `session.new` is answered (see
`gateway/src/session-handlers/ws-session-new.ts`): a surface has exactly one durable conversation on
2.0, so "+" clears the client's mirror but leaves the server-side thread — and its accumulated
context — intact.

The alternative was considered and rejected on evidence: minting a fresh partition per `session.new`
would fork on **every app launch** (the chat route's default `sessionId` is null, so
`ChatViewModel.init` fires `sendNewChat()` with no user tap — and the VM initialises *twice* per
launch, observed at `10:50:38.683` / `10:50:46.495` for one pid), destroying `reload-convergence`
and `restart-persistence`. Closing this properly is the multi-conversation project.

`01-newchat`'s header states a pre-2.0 premise ("the gateway now mints + broadcasts session.created
on the fresh-chain first message") that 2.0 does not implement. **Left unedited on purpose** — it is
the standing acceptance test for multi-conversation.
