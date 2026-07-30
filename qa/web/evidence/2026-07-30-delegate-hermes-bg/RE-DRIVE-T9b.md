# delegate-hermes-bg + steer-followup-audio — RE-DRIVEN after T9b's D1/D2 fix

**This is the first time in this project's history that `delegateTask` has returned a real
delegated completion.** It is the acceptance criterion for the whole native-stack migration.

## How it was driven

Real gateway on `:8888` (`bun --hot`, all five T9b fixes in), real Ollama-Cloud
`gpt-oss:20b-cloud`, real docker MCPs, real native whisper-stt + local-tts, real `hermes` binary.

The user was created through the **real admin path** during this same session — `POST
/api/v1/admin/users` with a PASETO admin session token → `u_885ffeb7`. Its hermes profile was
created by the new provisioner, not by hand (`hermes-profile.create.ok elapsedMs=359`).

Driven over the **real gateway WS seam** (`wss://…/api/v1/ws`: `auth` → `session.configure` →
`text.input`, reading the `turn.*` / `delegation.progress` frames) rather than through Playwright.
Same protocol the webui speaks; only browser rendering is skipped, which is not what these rows
were blocked on. **Stated as a limitation, not claimed as browser coverage** — see "Not covered".

## delegate-hermes-bg → PASS

```
+8ms     turn.started            trigger="user"
+~0.7s   turn.tool.update        toolName="delegateTask" status="running" argsPreview={"agent":"hermes",…}
+~0.7s   delegation.progress     agent="hermes" status="running"          ← {taskId} returned immediately
+4096ms  delegation.progress     taskId="33fd1031…" status="done"          ← REAL completion
+5242ms  delegation.progress     taskId="d4e16b00…" status="done"
+6356ms  turn.completed
```
Gateway log trail, same run:
```
hermes-runner.run.start | userId="u_885ffeb7" cwd="…/u_885ffeb7/profiles/u_885ffeb7" timeoutMs=600000
hermes-runner.run.ok    | userId="u_885ffeb7" elapsedMs=3248 outputLength=85
delegate-task.run.ok    | taskId="d4e16b00…" agent="hermes" outputLength=85
```
**5 × `hermes-runner.run.ok`, 0 × `non-zero-exit`.** Before the fix this was 0 × ok and
100 % `non-zero-exit` with `Profile '<userId>' does not exist`.

## steer-followup-audio → PASS on the steer/new-bubble half; audio half NOT verified

A background completion that resolved AFTER the dispatching turn's final answer started a genuine
back-to-back turn — spec §4.5 — with the correct trigger:
```
+6356ms  turn.completed  turnId="1c5d5b27…"
+6357ms  turn.started    turnId="61f01ef4…" trigger="background-completion"
+6877ms  turn.completed  turnId="61f01ef4…"
…chain terminates at +11082ms (converges, does not run away)
session-runtime.turn.next-turn-trigger | previousTurnId="1c5d5b27…" nextTurnId="61f01ef4…" trigger="background-completion"
```
This also confirms T9b's D3 fix removed only the PHANTOM follow-up (a steer already consumed
mid-loop) and left the genuine post-final-answer follow-up working.

The row's *audio* assertion ("audio queues behind the still-playing turn") is **NOT verified** — the
WS driver did not negotiate `audio.output`. Needs a browser or mobile drive.

## interrupt (background-cancel arm) → NOT RE-DRIVEN

Now *reachable* for the first time (a delegated task genuinely runs ~3.2-3.8 s, so a Stop can land
while one is in flight), but not driven in this session. Left as-is rather than flipped.

## NEW DEFECT FOUND — D7: the model re-dispatches the same delegateTask 10× per request

```
call_jq19j9ua, call_s2kggb8k, call_to4x8zi5, call_5ftlkgxg, call_5bugysqx,
call_n59f0bp7, call_xbyo1g04, …   — 10 delegateTask calls, one every ~700ms,
                                    all with the same taskPrompt, each spawning a real hermes process
```
`delegateTask` is a BACKGROUND tool: it returns `{taskId}` with no answer, the loop's next iteration
re-reads the store, the model sees a dispatch with no result and calls it again. Classic two-way /
background-tool refire (`reference_pre_hermes_loop_pitfalls`: "3x-refire"). It converged here
(the chain ended), so it is not a hang — but one user request spawned **ten** hermes subprocesses
and burned ten LLM iterations. Real cost + resource defect, needs its own fix (likely a
"dispatched, do not re-dispatch" affordance in the tool_result text and/or a per-turn dedupe on
`(toolName, args)` for background tools). **Not fixed in T9b** — found by this drive, out of its
declared scope, filed here for the next task.
