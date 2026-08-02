# Group C — delegation permission gate

Driven live via Playwright MCP against the real local dev stack (`http://localhost:5173`
webui, gateway `bun --watch` on `:8888`, real docker MCP addons, real native
whisper-stt/local-tts, real `hermes` binary). Pre-flight: `bun qa/web/stack-integrity.ts` →
`RESULT PASS — pass=9 fail=0 skip-optional=0 of 9 declared` (run at 16:04:36, before driving).

Logged in as **Ada** (`u_0417d3b0`) via explicit logout → PIN-pad login (`1234`) at
`16:08:21` — `authenticate.ok userId="u_0417d3b0"`, chosen so the log grep below only picks
up this run. Model in Ada's profile: **`deepseek-v4-flash:cloud`** (confirmed from
`[provider:openai] stream-start model="deepseek-v4-flash:cloud"` on every turn below) — this
matters for row 3, see below.

Raw log excerpts: `group-c-log-excerpt.txt` (same directory). Screenshots:
`screenshots-group-c/`.

---

## ROW 1 — `delegate-dialog-args` — **PASS**

**Oracle stated up front:** the dialog's rendered DOM (read via `browser_evaluate` on the
actual elements, not a screenshot — a screenshot cannot prove text isn't clipped by CSS) must
contain the full `taskPrompt`, ending in a distinctive tail marker; each argument must be its
own row; a long value must scroll within a bounded box rather than truncate or overflow the
viewport.

**Drive:** sent a 616-char chat message beginning "Delegate this to Hermes verbatim, do not
paraphrase or shorten it: Research the history and engineering of mechanical clocks…" ending
in `...TAIL-MARKER-ZX99`, explicitly instructing the model to relay it verbatim so a large
fraction of it would land in `taskPrompt`. Stopped at the dialog — did not answer it.

**What actually rendered** (`role="dialog" aria-label="Permission requested"`):
- 2 `.permission-dialog__arg` rows — `agent` and `taskPrompt` — one row per argument, confirmed
  by `dialog.querySelectorAll('.permission-dialog__arg').length === 2`.
- `taskPrompt` value, read via `.permission-dialog__arg-value` `textContent`: **549 characters**,
  ending exactly `"...nothing was truncated: TAIL-MARKER-ZX99"`. `dialog.textContent.includes('TAIL-MARKER-ZX99') === true`.
- Computed style on the value element: `white-space: pre-wrap`, `overflow: visible`,
  `text-overflow: clip` — no CSS-level clipping is possible; the full string is in the DOM and
  laid out, just wrapped.
- Computed style on the parent `.permission-dialog__args` container: `overflow-y: auto`,
  `max-height: 360px` — a bounded, scrollable box, not a page-overflowing dump. (In this
  specific run `scrollHeight === clientHeight === 298px`, i.e. under the 360px cap so it didn't
  need to actually scroll — the mechanism is what's being asserted, and it's there: a
  longer/multi-paragraph `taskPrompt` would scroll inside this box per the CSS, not spill past
  the dialog or the viewport.)
- Dialog bounding box: 420×574 at (430,163) inside a 1280×900 viewport — fits entirely on
  screen.

**Log**, correlating at 16:09:07 (see excerpt file):
```
tool-broker.pdp.decision | tool="delegateTask" action="confirm" rule="confirm_delegate_task"
permission-broker.request | toolName="delegateTask" argKeys=agent,taskPrompt timeoutMs=120000
turn-emitter.permission-request | toolName="delegateTask" argKeys=agent,taskPrompt
```

**Could this oracle still have failed?** Yes, meaningfully — if the old 80-char elision or the
one-line-summary bug were still present, `dialogFullTextIncludesMarker` would have been
`false` (the marker is at char 549, `80 < 549`) and `argRowCount` would have been `1` (one
combined summary field instead of two named rows). Both would have failed loudly. This is a
real, non-vacuous check of the `11199c1` fix.

Screenshot: `screenshots-group-c/row1-delegate-dialog-args.png`.

---

## ROW 2 — `delegate-deny` — **PASS**

**Oracle stated up front:** (1) the assistant's reply acknowledges the decline and does not
claim it did the delegated work; (2) log shows `pdp.confirm-resolved confirmed=false`; (3) zero
`hermes-runner.run.start` anywhere from this point forward; (4) no immediate retry of the same
`delegateTask` call.

**Drive:** pressed **Deny** on the row-1 dialog.

**Reply, verbatim (first sentence):** *"The delegation was declined, so I'll research it
myself. Let me gather information on each topic."* — followed by a real, ~1400-word researched
write-up on mechanical-clock escapements, assembled via 4× `search_web` + 7× `fetch` (the
model's own foreground tool calls, all `action="allow"` under `allow_search_web`/`allow_fetch`
— no further confirm dialogs needed). This satisfies the oracle: it names the decline and does
not pretend the delegation produced anything; it also doesn't leave the user empty-handed,
though see the observation below.

**Log** (16:10:20, excerpt file lines 11–14):
```
permission-broker.settled | toolName="delegateTask" reason="denied" pending=0
tool-broker.pdp.confirm-resolved | tool="delegateTask" confirmed=false
tool-broker.dispatch.denied | tool="delegateTask" reason="The user declined this delegateTask
    call. Do not retry it; offer an alternative if one exists."
react-loop.tool-dispatch.foreground | toolName="delegateTask" isError=true resultLength=94
```

**No-retry check:** `grep 'tool="delegateTask"' | grep 'pdp.decision'` after 16:09:07 returns
**zero** further hits in this turn — the model called `delegateTask` exactly once, then moved
on to `search_web`/`fetch`, never re-attempting the delegation. This is the exact
`tool-broker.dispatch.denied` reason string doing its job — "Do not retry it" is fed back to
the model as the tool result, and it didn't.

**No-hermes-run check:** `grep -c hermes-runner.run.start` over the entire day's log up to the
row-3 approval (16:12:36) is **0**. The only `hermes-runner.run.start` anywhere in the day's
log is the one at `16:12:38.702`, which belongs to row 3's approved delegation, minutes later
and after an explicit Allow. Nothing ran off the back of the deny.

**Observation, not a failure:** the turn that followed the deny ran to
`react-loop.completed iterations=10 forceFinal=true` — it hit the loop's iteration cap and was
force-finalized. The model chose to do the equivalent research itself via 11 real tool calls
rather than give a short "I can't do that without approval" answer. Worth knowing (a denial can
now trigger a long, real tool-calling spree as the model's own choice to route around it), but
it is not what row 2's oracle checks and the final answer text was intact and non-truncated
when read from the DOM.

**Could this oracle still have failed?** Yes — if the fail-open path existed (e.g. `confirm`
silently defaulting to allow, or the ReAct loop skipping the PDP on retry), `hermes-runner.run.start`
would show up despite the Deny click, or `confirmed` would read `true`. Both are independently
checked in the log, not inferred from the UI.

Screenshot: `screenshots-group-c/row2-delegate-deny-final.png`.

---

## ROW 3 — `bg-no-card` — **MEASUREMENT, not pass/fail per the brief**

**Oracle stated up front:** (1) `document.querySelectorAll('.system-event').length === 0`;
(2) no raw fence markers or task-id strings visible in the primary chat content; (3) log shows
`turn-emitter.turn-started trigger="background-completion"`; (4) read what the follow-up reply
actually **says** — relay vs. mere acknowledgment vs. something else — and report verbatim.

**Drive:** fresh user turn — *"Delegate this to Hermes: tell me the exact year the first
commercially available electronic pocket calculator was released, and name that specific
model."* Dialog appeared with `taskPrompt` = that exact sentence. Pressed **Allow**. Waited
~35s (Hermes ran for 30.4s).

**Log** (16:12:37–16:13:10, excerpt file lines 25–50):
```
tool-broker.pdp.confirm-resolved | confirmed=true
delegate-task.run.guard-decision | action="allow"
react-loop.tool-dispatch.background | toolName="delegateTask" taskId="a99827bc-..."
[provider:openai] stream-end ... textLength=79   ← "Sent to Hermes..." ack, iteration 2 of the dispatching turn
hermes-runner.run.start
hermes-runner.run.ok | elapsedMs=30428 verdict="succeeded" outputLength=663
delegate-task.run.ok | outputLength=663
session-runtime.submit.start-turn | kind="background-completion" turnId="0b27464a-..."
turn-emitter.turn-started | trigger="background-completion"      ← oracle (3), confirmed
[provider:openai] stream-start | model="deepseek-v4-flash:cloud" messageCount=37 toolCount=29
[provider:openai] stream-end | finishReason="stop" completionTokens=1 promptTokens=31471
react-loop.iteration.stream-done | iteration=1 toolCallCount=0 textLength=0
react-loop.completed | iterations=1
turn-emitter.turn-completed
```

**Oracle (1) and (2), DOM check:**
```js
document.querySelectorAll('.system-event').length === 0   // true
document.body.textContent.includes('```')                  // false
document.body.textContent.includes('a99827bc-de46-49cd-8e17-e0ff4aecd974') // false
/taskId/i.test(document.body.textContent)                   // false
```
Both pass in the default (collapsed) view. One caveat found while poking at this: every tool
call in the feed — not specific to backgrounding — renders a collapsed `code` disclosure button
(e.g. `delegateTask`) that a user can click to inspect raw args/result; manually expanding that
widget on the "Sent to Hermes" bubble *does* reveal `taskId=a99827bc-...` in its result panel.
This is a general debug/inspector affordance present on every tool call in the thread (also seen
on the `search_web`/`fetch` calls in row 2), not something bg-completion-specific leaking into
the primary conversation text — but it does mean "no task-id visible on screen" is only true
until a user deliberately opens that panel. Flagging as an observation, not a row-3 failure,
since the oracle as written is about the chat content, which stayed clean.

**Oracle (4), the measurement — read verbatim:**

`react-loop.iteration.stream-done` for the background-completion turn reports
`toolCallCount=0 textLength=0`, and the underlying provider call shows
`completionTokens=1 finishReason="stop"` — the model emitted a single token (almost certainly
an immediate stop/EOS) and **zero characters of visible text**. Confirmed independently in the
browser: `document.querySelectorAll('article').length` stayed at **5** before and after this
turn (checked twice, 10s apart, well after `turn-emitter.turn-completed` at 16:13:10.668) — **no
sixth bubble of any kind appeared**. The user-visible outcome of approving this delegation and
waiting for it is: the "Sent to Hermes..." message, and then *nothing*. Not an acknowledgment,
not a relay — silence. (No `.system-event` card either, since that mechanism was removed
2026-07-31 per `d0a059f`, and there is no other feed-artifact path for a background result — a
turn with `textLength=0` and no tool calls simply renders no bubble.)

**Why this matters and what it's not:** this is the first live measurement of the
delegation-follow-up behavior on a model other than `gpt-oss:20b`. Per
`docs/native-todo.md` D16, the mechanical path is fully fixed and verified (role is `system`
on the stimulus per rule 5, the note names the task and echoes the request, the system prompt
has an explicit "Background tasks" section instructing the model to relay results — confirmed
present at `gateway/system_prompts/system_prompt.md:31-38`). D16 as filed was measured 0/9 on
`gpt-oss:20b`, where the model at least emitted *some* text — a vacuous acknowledgment
("Got it—thanks for the update!"). What I measured here on `deepseek-v4-flash:cloud` is a
different and, on its face, worse outcome: not an acknowledgment at all, but a completed turn
with **one completion token and no visible reply whatsoever**. Per the brief, this is not
scored FAIL — it's the requested data point on the model Ada actually runs, and D16 explicitly
says "test that before changing the projection." This result argues the open question isn't yet
closed by a stronger model; if anything it surfaces a second failure shape (silent no-op) worth
folding into D16 alongside the "acknowledges without relaying" shape.

**Could this oracle still have failed to show something?** Yes in one direction: this is a
single trial. D16's own gpt-oss:20b measurement used 9 trials across three framings because
single-sample LLM behavior is noisy. One `deepseek-v4-flash:cloud` trial is a real, honest data
point, not a statistically settled verdict — a re-run could plausibly land on "acknowledges" or
even "relays." I'm reporting exactly the one trial I ran, not generalizing further.

Screenshot: `screenshots-group-c/row3-bg-no-card-final.png` (shows the feed frozen after the
"Sent to Hermes..." bubble — no follow-up content below it).

---

## Summary

| Row | Result | Oracle used |
|---|---|---|
| `delegate-dialog-args` | **PASS** | DOM read (not screenshot) of dialog args: row count, full taskPrompt text incl. tail marker, computed CSS confirming no truncation and a bounded scroll box |
| `delegate-deny` | **PASS** | `pdp.confirm-resolved confirmed=false` + zero `hermes-runner.run.start` anywhere up to that point + zero delegateTask retry + reply text read verbatim |
| `bg-no-card` | **MEASUREMENT** (per brief, not pass/fail) | `.system-event` count, DOM leak check, `trigger="background-completion"` log line, and the follow-up turn's actual text read verbatim: **empty** (`completionTokens=1`, no 6th bubble ever rendered) on `deepseek-v4-flash:cloud` |

Nothing here needed a Hermes-level failure (401 or similar) worked around — the real `hermes`
binary ran successfully both times it was invoked (row 3's approved run: `verdict="succeeded"`,
0 failures). No fixes were applied; this file only records what was driven and observed.
