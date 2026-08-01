# Task 12 · Step 6 — the rows the PIN was blocking (part 2 of 2)

## `interrupt` — browser Stop arm, background-cancel → **PASS**

The assertion the step demands is precise: *"asserting the background task is
actually cancelled (the subprocess is gone), not merely that the turn aborted."*
The previous verdict was "primitive PROVEN, browser trigger not driven" — the
`cancelAll()` → `delegateTask.cancel` → `proc.kill()` chain had been exercised by
hand, but never from a real Stop click, because that needed an authenticated
browser session.

Log: `gateway-log-step6-interrupt.txt` (unedited).

### The oracle is a pid, watched, not a log line

A log line saying "cancelled" is the gateway's opinion about itself. So a
watcher sampled the gateway's direct children (`pgrep -P <gateway pid>`) every
200 ms for the whole drive, independently of the gateway:

```
samples=61   first=18:31:38.3   last=18:31:53.3
pid=16239  cmd=/Users/kevinye/.hermes/hermes-agent/venv/bin/python3 …
```

61 consecutive samples — the hermes one-shot was genuinely alive for ~15 s,
not a race against a process that was about to exit anyway
(`hermes-runner.run.start` at 18:31:38.561 matches the watcher's first sample).

### The click, and what it did

Stop clicked at **18:31:53.677**, while `hermes-runner.run.ok` had *not* fired.

```
18:31:53.677  cancellation.no-turn-in-flight   cutoff="interrupt" cancelBackground=true
18:31:53.677  turn-voice.audio.cancel          turnIds=a6571760…,ca36e899…  reason="user cancel gesture"
18:31:53.678  session-runtime.playback.stop    cutoff="interrupt" cutTurnCount=2
18:31:53.679  hermes-runner.run.aborted  (WARN) elapsedMs=15118
18:31:53.680  background-registry.cancel-all   taskIds=da57b4ef-… count=1
18:31:53.680  cancellation.background.cancel-all  cutoff="interrupt"
18:31:53.680  synthesize-aborted               frameCount=5
18:31:53.681  turn-voice.audio.cancelled       turnId=a6571760… frameCount=5 bytesSent=61884
18:31:53.685  hermes-runner.run.done-after-abort  elapsedMs=15124
18:31:53.686  delegate-task.run.failed  (WARN) taskId="da57b4ef-…" reason="aborted"
```

Whole cancellation completed in **9 ms**.

### The subprocess is gone — verified three ways

| Check | Result |
|---|---|
| `ps -p 16239` | **exit 1** — no such process |
| `pgrep -f hermes-agent` | empty |
| watcher samples after 18:31:54 | **0** hermes children, ever again |

The process was alive across 61 samples and vanished within one 200 ms sample of
the click. That is the subprocess actually dying, established outside the
gateway's own reporting.

### `cancellation.no-turn-in-flight` is the correct line here, not a miss

The dispatching turn's text had already settled when Stop was clicked, so there
was no turn to abort — the interrupt hit the background task and the audio.
This is the documented valid path (`interrupt` case notes: *"or
`cancellation.no-turn-in-flight` if text already settled — still valid,
audio-stop runs unconditionally either way"*), and `cancelBackground=true` is
what carries the background kill. Two turns' audio was cut
(`cutTurnCount=2`), including the queued follow-up from the previous drive.

### What this row does NOT claim

`barge-in` remains undriven and is a different cutoff kind: the webui Stop always
produces `cutoff="interrupt"`, and `runtime.bargeIn()`'s only production caller
is real STT speech-onset. That needs a microphone and is not reachable from
Playwright.
