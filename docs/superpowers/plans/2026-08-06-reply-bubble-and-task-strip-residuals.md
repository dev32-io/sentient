# Reply Bubble + Task Strip — Residuals and Owner Decisions

Companion to `2026-08-06-reply-bubble-and-task-strip.md`. Everything the 15-task
build deliberately did **not** fix, why, and what needs your call. Nothing here
blocks the branch; every item was found by review, adjudicated, and recorded
rather than silently dropped.

## What shipped

The reported bug is fixed and verified on all three surfaces. A reply produced
across several ReAct iterations renders as **one** bubble live, committed, and on
replay. Tool rows left the conversation feed entirely and live in a composer
strip fed by a server-authoritative full-state `tasklist.state` frame; the
gateway owns which rows exist and how long each lives.

The red gate is `gateway/src/runtime/reply-bubble-convergence.test.ts` — a
scripted provider driving `text → tool → text → tool → text`, the exact shape of
the 2026-08-05 iOS vitals. Disabling the fold in `client-projection.ts` fails 8
tests across 4 files.

## Needs your decision

### 1. Mid-stream steer — live and committed disagree

A steer landing mid-stream rotates `inFlight.replyId` before the terminal entry
is appended (`react-loop.ts:586`/`:621` read `currentReplyId()` at *append* time),
so the answer's deltas stream partly under the old id and partly under the new
one while the whole iteration commits under the new one.

Live shows `[bubble r1 = A][user row][bubble r2 = B]`. Committed shows
`[user row][bubble r2 = A+B]`. Text is neither lost nor duplicated — it
**relocates below the user's message** at commit. Narrow, converges, ugly.

Cheapest fix: capture `currentReplyId()` **once per iteration** before
`consumeStream` rather than at each append.

### 2. Cancel-to-clear ordering

`cancellation.ts:329` emits `turn.aborted` synchronously while the strip clears
in the async settle at `session-runtime.ts:710`. A Stop during a foreground tool
leaves that row on the strip until the loop unwinds.

Originally logged as a 30-second lag; that was **wrong**. `inv.signal` reaches
`client.callTool` (`mcp-client.ts:424-427`) and the catch at `:456-471` returns
promptly on abort, so the post-await check fires within a tick. The residual is
ordering only, bounded by `request_timeout_ms` in the worst case of a stalled
provider stream.

### 3. Android permission dialog hides the delegated instruction

`PermissionPromptDialog.kt:88-104` renders only `toolName` + `description`, never
`request.args`. Authorising a `delegateTask` on Android therefore hides the
`taskPrompt` — you approve an unsupervised agent run without seeing what it was
told to do. Web renders args in full (`permission-dialog.tsx`). Pre-existing, but
it is a consent surface.

### 4. `emitTaskList()` on the fresh-mint path

Declined deliberately. The strand starts the instant "+" unbinds the socket
(`ws-session-new.ts:103`), before any mint, so a server push on that branch fires
after the symptom is already on screen. The right seam is `sendDraftHandshake`,
which has no runtime bound — clearing there would mean hand-rolling a
`tasklist.state` no projector owns. Web is covered client-side instead. This
becomes a real requirement for any surface with no client-side rule (the ESP32
cube).

### 5. `emitTaskList()` at four call sites, not one

It is called after each of the four `completeAttachWithSnapshot` sites. Reviewer
confirmed there is no attach path where publishing the strip would be wrong, and
that `completeAttachWithSnapshot`'s own docstring already covers this class of
transient prerequisite. Moving it inside that function makes it structural —
which is what `conversation-feed.ts` warns about in its own words: *"asking it in
two places is how they drift."* The sibling `completeAttach` (fresh mint /
recovered resume) must **not** fire it and is structurally separate, so the move
is safe.

## Known defects, verified, not fixed

| # | Where | What |
|---|---|---|
| D2 | `ios/App/Chat/message/MessageBubble.swift:65` | `.accessibilityIdentifier("assistant-bubble")` sits on the outer `HStack` with no `.accessibilityElement(children: .contain)`, so SwiftUI bleeds it onto every markdown leaf — 18 nodes in Maestro's own captured hierarchy for one reply. Makes `assertNotVisible: {id: assistant-bubble, index: 1}` unsatisfiable on iOS, and VoiceOver announces every paragraph as "assistant-bubble". Android is one node per bubble. (The new `ComposerTaskStrip` got the `contain` modifier; the bubble did not.) |
| D3 | `ComposerTaskStrip.kt:86` | Android pill-row horizontal scroll never showed a measurable offset. The drawer conflict a review feared is **disproven** (10+ swipes, both directions). `Composer.kt:184-197`'s ancestor `detectVerticalDragGestures` is a plausible shared cause for both observations. Needs a human finger. |
| D4 | tooling | Maestro CLI 2.6.0 (`~/.maestro/bin`) vs MCP 2.7.0 (homebrew) fight over the iOS simulator-server; connect failures read as app bugs. |
| D5 | `Composer.kt` | Android mic corner overlaps the strip's swipe band; an accidental drag locks hands-free listening. |
| — | `session-runtime.ts:560-573` | `commitTurnFailure` uses `blankEntry` → `replyId: null` while absorbing `turnText`, so a **failed** turn commits two bubbles where live showed one. Rare path, no data loss. Now the only remaining producer of an unstamped assistant row. |

## Cross-platform divergence worth closing

- No surface renders `kind` — a 10-minute `delegateTask` and a 200 ms search look
  identical, though the wire carries the discriminator specifically so they need
  not. No surface renders elapsed time.
- `task-pill-<id>` is untestable on both mobile surfaces: `id` is an opaque
  `toolCallId`/`taskId`, which is why no Maestro flow uses it.
- Naming split: `task-*` (mobile) vs `tool-*` (web). Web has zero `data-testid`
  hooks repo-wide; every web assertion is a CSS-class selector.
- iOS is the only surface with no horizontal scroll. Web is the only one with a
  tool icon, and its status dot is on the opposite side of the name from both
  mobile surfaces.

## Test-coverage residuals

- `conversation-feed.ts`'s `heldBackFromSeq(pending, …)` — the pending-window vs
  full-history choice is the single most load-bearing untested line in the feed.
  A future change back to `heldBackFromSeq(entries, …)` would rewind the cursor
  and nothing would catch it.
- `phase-services.ts`'s `runtimeRef` forward-reference wiring has no regression
  test; reverting it produces zero failures. Consistent with the repo's
  DI/factory exemption, but it is the exact layer a Critical lived in.
- Four `as unknown as SessionRuntime` doubles in `ws-handlers-routing.test.ts`
  defeat the required-method compile guard — they failed at **runtime**, not
  compile time, when `emitTaskList` was added. `turn-emitter.ts` leans on that
  guard as its design argument against optional methods.
- Web's `DelegationProgressConnector` is not cleared at the conversation
  boundary though mobile clears its mirror there. Invisible today —
  `delegations` is exported from `use-voice-client` with zero consumers.

## Two narrow live-rendering seams (found in final re-review, not fixed)

- A joiner attaching in the window between a rotation and the first delta of the
  new reply still gets the old reply replayed as live text beside its committed
  row. The tracker sees deltas, never the rotation itself.
- Web keeps a live bubble open for the pre-rotation reply alongside its
  now-committed row until `turn.completed`, since `InFlightMessageConnector`
  retains both buffers while the feed publishes the old one at rotation.

## Safety change made along the way

An agent-driven Maestro run actuated a real light at night. `12-permission-confirm`
on both platforms sends "turn on the kitchen light" and taps Allow, and was tagged
`chat` only — the same tag that selects the chat-stream flows — while
`run-e2e.sh`'s `flow_matches()`/`EFFECTIVE_EXCLUDE` has no per-flow exclude.

Closed by a new `device-actuating` tag, added to `BASE_EXCLUDE` and applied to
both flows. `physical-only` was the wrong tag to reuse: it means *needs a real
device*, a different axis from *changes the world*. Every prompt in the e2e
matrix is now read-only, and a standing note above the matrix says why.
