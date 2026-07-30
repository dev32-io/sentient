# Native mobile E2E matrix — 2026-07-30 (native-stack migration, Task 10)

Driven against the local dev stack: native gateway (`bun --hot src/main.ts`, `:8888`, binds
`0.0.0.0`), docker addons on loopback, native whisper-stt (`:8768/8769`) + local-tts (`:8770/8771`)
both `{"status":"ok","version":"1.3.0"}`. Devices: Android `emulator-5554` (Pixel_3a_API_34, dials
`10.0.2.2:8888`) and iOS sim `43FC67B5-6A96-4EE7-A23B-778C8849D23F` (iPhone 17, iOS 26.5, shares the
host network). Both apps rebuilt from this branch's 2.0 SDK before driving anything.

Never prod. Nothing in this directory was driven against `mini0.lan` / `sentient.dev32.io`.

---

## D12 (NEW, matrix-blocking) — the gateway never answers `session.new`, so no mobile text send can leave the device

**Severity: blocks every chat-bearing row of the native matrix on BOTH platforms.**

`gateway/src/session-handlers/ws-handlers.ts:189-196` routes `session.new` and
`conversation.activate` into the `default:` arm:

```ts
    default:
      // session.new / conversation.activate still require the
      // multi-conversation wiring landing in its own Plan 3 task. Received
      // but unhandled.
      log.debug("message-unhandled", { type: msg.type, reason: "not yet wired" });
      return;
```

Both reply frames exist in the **frozen** 2.0 protocol —
`shared/protocol/src/sessions.ts:40` (`session.created`) and `:57` (`session.switched`) — but
no gateway source file emits either one:

```
$ grep -rn "session.created\|session.switched" gateway/src --include=*.ts | grep -v '\.test\.'
gateway/src/session-handlers/ws-session-configure.ts:390: *    ... so the synthetic `session.switched` reaches no
gateway/src/session-handlers/ws-handlers.ts:219:  log.info("stt-session-created", …)   # unrelated (STT)
```
(one prose comment and one unrelated log line — zero emitters.)

The mobile client hard-requires that reply. `SentientSdk.onSessionAnchored`
(`shared/mobile-sdk/.../sdk/SentientSdk.kt:861-865`) is the **only** writer of
`_currentSessionId`, and it is driven exclusively by `session.created` / `session.switched`.
`SendMessageUseCase.flushIfReady`
(`shared/mobile-data/.../usecase/SendMessageUseCase.kt:47-50`) gates the outbox drain on that id
being non-null:

```kotlin
        val sessionId = attachedId.value
        if (sessionId == null) {
            log.info("flush-skipped", mapOf("reason" to "no-id-attached"))
            return
        }
```

So the composer accepts the text, mints a `pendingId`, enqueues it — and the send never leaves the
device. Not a dropped reply, not a timeout: the frame is never written to the socket.

### Observed, both platforms, identical

Android (`android-logcat-outbox-blocked.txt`):
```
ready.first-connect anchored=null
ready.first-connect.retry-pending-mint
connector.sessions: sendNew requestId=668a51f1ace71686
data.send-message: flush-skipped reason=no-id-attached
android.chat-viewmodel: send len=16 pendingId=692d97a3-5ed2-4b2f-b192-f6ce71efe476
data.send-message: flush-skipped reason=no-id-attached      <-- the send dies here
```

iOS (`os_log`, same drive):
```
connector.sessions: sendNew requestId=338746ac32fd98d5
data.send-message: flush-skipped reason=no-id-attached
data.send-message: flush-skipped reason=no-id-attached
```

Gateway side (`gateway-log-no-session-new-reply.txt`) — the socket is fully healthy and the tool
broker even warms 18 MCP tools, and then **nothing**: no `text.input`, no `react-loop.start`, no
`turn.*`, not one line after the MCP warm-up:
```
INFO [ws:session-configure]  session-configured … capabilities=…,sessions,… clientType="mobile"
INFO [ws:turn-emitter]       turn-emitter.conversation-snapshot | itemCount=0
INFO [tools:tool-broker]     tool-broker.mcp-warmup.ok | toolCount=18
<end of trail — the client's session.new produced no response and no turn>
```

### Why the web matrix (Task 9) did not catch it

Task 9 drove the web surface at the **WS seam** and via the browser SDK, which anchors its
conversation differently — it does not gate its send on a `session.created` echo. The gate is in the
KMP `SendMessageUseCase`, mobile-only. This is the exact failure class this migration exists to
surface: 1138 green unit tests and a green web matrix, and the mobile chat path cannot send a single
message.

### Repro (2 minutes, no PIN needed beyond the committed QA one)

```bash
export SENTIENT_CODE=<staged tree>            # see the report; only needed for addon supervision
cd gateway && bun --hot src/main.ts &
./qa/mobile/run-e2e.sh android --tags chat
# or a single flow:
maestro --device emulator-5554 test -e QA_USER_ID=u_0417d3b0 qa/mobile/flows/android/01-send-stream.yaml
adb logcat -d | grep -E "sendNew|flush-skipped"
```

### Not fixed here, deliberately

`gateway/**` and `shared/**` are outside this task's file ownership. Handed to Task 11.
The fix is a gateway change (emit `session.created` in response to `session.new`, and
`session.switched` in response to `conversation.activate`), not a QA change — the flows are correct
and the assertions are correct.

---

## Row outcomes

See the report and `agents/docs/testing-knowledge.md` for the per-row table.
