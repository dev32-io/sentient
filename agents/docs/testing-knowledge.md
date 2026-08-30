<!-- last-distilled: 2026-08-30 branch: develop -->
# Testing Knowledge

This is the reusable smoke-case catalog for the current native gateway and
clients. Dated plans, QA evidence, and pre-2.0 investigations remain historical;
do not copy their retired Cerebrum, ACP, `cycle.*`, container-gateway, or
Raspberry Pi commands into a new test.

The governing rules are `.claude/rules/guardrails.md` and
`agents/docs/e2e-testing-details.md`.

## Safety and fixtures

- Local E2E uses the real local stack at `https://localhost/`.
- Production is observational-only. Never send a test chat, drive a client,
  mutate data, restart services, or deploy without explicit per-action approval.
- The disposable local login fixture is `Ada` with PIN `1234`. It may be reset
  with local state and must never be assumed to exist in production.
- Evidence must not contain API keys, tokens, private URLs, prompts, message
  text, transcripts, household data, raw frames, or audio. Record synthetic
  inputs, identifiers, types, sizes, state transitions, and sanitized reasons.
- Use read-only tools and household integrations unless a case explicitly owns
  disposable local state and cleanup.

## Bring up the local stack

```bash
source scripts/env.sh
bun run dev
```

Wait for the outward edge, not the gateway's diagnostic listener:

```bash
until curl -sk -o /dev/null -w '%{http_code}' https://localhost/ \
  | grep -q 200; do sleep 1; done
```

Use `bun run stack:status` for diagnostics and `bun run stack:down` for cleanup.
The gateway runs with `bun --watch`; never use `bun --hot`. Docker Compose does
not run the gateway.

## Test drivers

### Browser

Use Playwright MCP against `https://localhost/`. Exercise desktop `1280x900`
and mobile `390x844` only when layout behavior differs. Prefer visible
interactions over DOM-evaluated clicks. Capture sanitized console/network
summaries and screenshots only when they are material evidence.

### Android and iOS

Build/install the app, then use checked-in Maestro flows through:

```bash
./qa/mobile/run-e2e.sh android --tags <tag>
./qa/mobile/run-e2e.sh ios --tags <tag>
```

Android emulator fallback is `wss://10.0.2.2:443/api/v1/ws`; iOS uses its
configured host endpoint. Physical microphone, acoustic echo cancellation,
speaker behavior, signing, and paid-provider flows are operator-driven device
cases, not simulator passes.

### ESP32 cube

Use `esp32/devtool` for flashing, logs, capture, and protocol diagnostics. The
cube is a development client and is not yet aligned with the complete current
wire contract; do not report broad client parity from a partial firmware smoke.

### Unit and contract checks

Use the narrowest affected package check while iterating, then run:

```bash
source scripts/env.sh
bun run lint
bun run typecheck
bun run test:unit
git diff --check
```

Tests should pin wire contracts, state machines, authorization boundaries, and
reported regressions—not trivial wiring or incidental presentation.

## Reusable cases

### TK-001 — Fresh draft becomes one durable session

**Scenario:** A signed-in user opens a new chat and sends one text message.

**Why:** Protects draft idempotency and server-minted session ownership.

**Steps:**
1. Open a fresh local chat with no selected conversation.
2. Confirm the empty state.
3. Send one synthetic prompt and wait for completion.

**Expected:** The client receives a draft boundary, the first message mints one
opaque `sessionId`, one assistant reply streams and commits, and history shows
one durable conversation. Reconnect must not mint a duplicate for the same
first send.

### TK-002 — Live text converges with committed history

**Scenario:** A normal text turn streams before its committed entry arrives.

**Why:** Live and replay projections must not duplicate or lose the assistant
bubble.

**Steps:** Send one synthetic prompt, observe the streaming bubble, wait for
`turn.completed`, then reopen the conversation.

**Expected:** Text grows in one bubble keyed by `replyId`; the committed entry
replaces/adopts the live bubble without a duplicate. Reloaded history renders
the same settled conversation.

### TK-003 — Multi-tool work stays in the composer strip

**Scenario:** A read-only request causes one or more foreground tool calls.

**Why:** Tool state is a server-authoritative `tasklist.state`, not a chat-feed
item.

**Steps:** Use a safe local read-only tool request and observe the conversation
and composer while it runs.

**Expected:** Running/done/error tool rows appear only in the composer strip.
Narration and the final answer remain assistant content; no tool bubble is added
to conversation history.

### TK-004 — Permission request closes on every outcome

**Scenario:** A tool configured as `ask` requests confirmation.

**Why:** A model-emitted call is not authorization, and prompts must not remain
stuck.

**Steps:** Exercise approve, deny, and timeout with disposable local state.

**Expected:** Each prompt is tied to one `requestId`, resolves once, disappears
from every attached window, and executes only after approval. Deny/timeout
perform no mutation.

### TK-005 — Speaking follows audio drain

**Scenario:** A reply finishes text generation before local TTS audio drains.

**Why:** `turn.completed` can precede the final audio frame.

**Steps:** Request a sufficiently long synthetic spoken reply and watch the
speaking/interrupt state through the last audio.

**Expected:** Speaking remains active until playback drains. Audio is bracketed
by `turn.audio.start`/`turn.audio.done`; no text or frame payload is written to
logs or evidence.

### TK-006 — Interrupt and barge-in stop only the turn

**Scenario:** The user interrupts active speech through the Stop control or new
speech.

**Why:** Cancellation must stop the turn and TTS without silently cancelling
background work.

**Steps:** Start a spoken reply, exercise Stop; separately exercise real-device
barge-in where an acoustic test is available.

**Expected:** Playback stops promptly, the partial reply records the correct
`interrupt` or `barge-in` cutoff, and the active turn aborts. A background task,
if present, remains eligible to complete later.

### TK-007 — Follow-up does not flush earlier queued audio

**Scenario:** The user sends a text follow-up while earlier audio is playing.

**Why:** A new turn is not an implicit playback cancellation.

**Steps:** Start a long spoken reply, send a follow-up without pressing Stop,
and observe both turns.

**Expected:** The follow-up is accepted/steers according to runtime state;
earlier audio is not flushed merely because another turn begins. Only
`playback.stop` clears queued audio.

### TK-008 — Reconnect resumes or snapshots cleanly

**Scenario:** A client loses the local gateway connection while attached to a
durable session.

**Why:** Resume gaps and stale cursors must not duplicate conversation state.

**Steps:** Interrupt local connectivity or restart only the local gateway, then
restore it and observe the same client.

**Expected:** A retained contiguous journal produces `stream.resumed` recovery;
an epoch/gap mismatch produces a fresh committed snapshot. Both paths converge
without duplicate messages, stuck tool state, or a new conversation.

### TK-009 — Multiple windows share one runtime

**Scenario:** Two browser windows attach to the same durable session.

**Why:** Session authority and journal sequencing are session-scoped, not owned
by whichever socket connected last.

**Steps:** Open the same conversation in two local windows, send from one, then
interrupt or answer a permission prompt from the other.

**Expected:** Both windows receive identical session-lane frames and converge on
the same history/task state. Stale attachment generation on a bound command is
rejected explicitly rather than applied to the wrong conversation.

### TK-010 — Session switching has an explicit boundary

**Scenario:** A user switches between two existing conversations.

**Why:** Route/surface changes must not leak live state between sessions.

**Steps:** Create two disposable local conversations, switch between them, and
return to the first.

**Expected:** `conversation.activate` changes the live attachment, REST message
history replaces the committed mirror, and in-flight/transient UI from the
other conversation is absent.

### TK-011 — Delegation survives spoken-response cancellation

**Scenario:** `delegateTask` starts one optional Hermes subprocess and the user
interrupts the spoken turn.

**Why:** Hermes is background one-shot work, not the session runtime.

**Steps:** With Hermes configured locally, start a harmless delegated task,
interrupt the reply, and wait for its bounded completion.

**Expected:** The turn and audio stop, delegation progress remains coherent, and
the completion returns later as a session stimulus. No standing Hermes service
or polling loop is created.

### TK-012 — Spark degrades without blocking a turn

**Scenario:** Deep Memory is healthy, irrelevant, slow, or unavailable at turn
start.

**Why:** Proactive recall is optional context and must preserve privacy and
latency bounds.

**Steps:** With disposable synthetic memory, exercise one relevant query and
one unrelated query; separately stop only the local Deep Memory addon.

**Expected:** Relevant permitted snippets may enter the situation block; an
irrelevant result, timeout, or unavailable service injects nothing and the turn
continues. Child/audience and user/household scope boundaries remain enforced.

### TK-013 — Mobile optimistic send reconciles by `pendingId`

**Scenario:** A mobile client sends while connected, loses the echo, reconnects,
and safely resends.

**Why:** `OutboundCache` is in-memory, VM-owned, and resend-safe—not a durable
outbox with a terminal SENT state.

**Steps:** Run the applicable debug fault flow, send one synthetic message,
drop the connection before echo, restore it, and observe the same route.

**Expected:** The entry remains QUEUED until its exact echo, may resend with the
same `pendingId`, and appears once after gateway deduplication. A timed-out
unechoed entry becomes FAILED and explicit retry reuses its id.

### TK-014 — Mobile navigation preserves authenticated ownership

**Scenario:** Android/iOS navigation recreates a chat route while the user stays
signed in.

**Why:** Route ViewModels must not own or close the shared SDK connection.

**Steps:** Sign in locally, enter a conversation, navigate away/back or switch
routes, then send another message.

**Expected:** `UserSessionManager` (Android) or `UserSession`/`IosUserSession`
(iOS) retains one connection scope. The route receives fresh screen state
without creating a second SDK or disconnecting on ViewModel teardown. Logout
closes the authenticated scope.

### TK-015 — Role and per-tool policy mediate execution

**Scenario:** The same local tool is `off`, `ask`, `allow`, or forbidden by role.

**Why:** Model tool output must never bypass execution authority.

**Steps:** Use disposable local users/configuration and a non-destructive tool.
Exercise each policy state through the real broker boundary.

**Expected:** `off`/role-forbidden tools are unavailable or denied, `ask`
requires confirmation, and `allow` executes only within the caller's attenuated
capability. No ambient current-user authority is consulted.

## Deliberate exclusions

- Production chats, browser/mobile smoke, schema writes, and deployments.
- Real household mutations or evidence containing household content.
- Physical microphone, speaker, echo-cancellation, signing, and push claims
  when only a simulator/browser was exercised.
- Claims that the ESP32 cube implements the complete current wire protocol.
- Historical ACP/Cerebrum/container-gateway cases; consult Git history or dated
  QA artifacts only when investigating those retired implementations.
