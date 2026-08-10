# stack-integrity — NM-T12 step 2

**Case:** `stack-integrity` · **Viewport:** n/a (host-level, no browser) · driver: `bun qa/web/stack-integrity.ts`

## Why this row exists

Nothing in 11 web E2E cases asserted that the services `config.yaml` **declares**
are the services actually running. `egress-proxy` once exhausted its retries and
every other case still reported green, because every other case only looked at
the webui.

The second reason is the oracle, not the row. `apply.complete state="ready"` was
true and meaningless for an entire branch: two stray per-user LaunchAgents held
8768/8769/8770 with pre-migration code, every gateway child died on `[Errno 48]`,
and the TCP probe was answered by **launchd's agent**. "Something is listening"
is the oracle that hid it. So this case asserts identity, not liveness:

| Gate | docker | native |
|---|---|---|
| declared | read from `config.yaml#managed_services` — never hardcoded | same |
| running | a container labelled `sentient.service=<name>` is `running` | the pid in `~/.sentient/run/<name>.pid` is alive |
| **identity** | **that** container publishes the declared probe port on loopback | the pid holding the LISTEN socket **is** the recorded pid |
| health | TCP connect to the declared `healthcheck.tcp` | same |
| quiet | no `reapply.gave-up` since the current boot; that boot's `apply.complete` has `state="ready" failed=0 blocked=0` | same |

## Files

- `drive-1-at-boot.txt` — live stack, gateway boot of 14:12:58 (apply 14:13:12). **PASS 9/9.**
- `negative-control.txt` — the oracle proving it can fail, against
  `qa/web/fixtures/stack-integrity-negative-control.yaml`.
- `drive-2-after-hot-reload-FAIL.txt` — the second drive. **It failed, and the
  failure is real** — see below.
- `gateway-log-hot-reload-wedge.txt` — the 309-line log trail behind that failure.

## Result

| Drive | Pre-state | Expected | Actual |
|---|---|---|---|
| 1 (at boot) | stack up since 14:12:58, untouched | 9/9 PASS, log window clean | `RESULT PASS — pass=9 fail=0 skip-optional=0 of 9 declared`, exit 0 |
| negative control | fixture declares 3 absent / impostor services | exit 1, one FAIL per gate | `RESULT FAIL — pass=0 fail=2 skip-optional=1 of 3 declared`, exit 1 |
| 2 (after reload) | gateway hot-reloaded 6× by this task's source edits | 9/9 PASS | **`RESULT FAIL — pass=7 fail=2 of 9`** — caught a real regression, see below |

**The negative control is the part that matters most.** Its third row reproduces
the exact shape of the bug that hid for a branch:

```
  FAIL           qa-port-impostor (native)
      running  pid 28031
      identity IMPOSTOR OR ORPHAN: :8086 held by [1508], orchestrator recorded 28031
      health   tcp 127.0.0.1:8086 ok        <-- a HEALTHY probe
```

`health` is green and the case still fails, because the process answering is not
the process the orchestrator recorded. Under the old oracle that row was a pass.

## Drive 2 — the oracle caught a live regression the same day it was written

Drive 2 is recorded as **FAIL, not deferred**. The stack was genuinely broken,
and the row is doing its job:

```
  FAIL           whisper-stt (native)
      running  pid 50534 is gone
      identity IMPOSTOR OR ORPHAN: :8768 held by [], orchestrator recorded 50534
      health   tcp UNREACHABLE

  FAIL           local-tts (native)
      running  pid 50545 is gone
      identity IMPOSTOR OR ORPHAN: :8770 held by [50544], orchestrator recorded 50545
      health   tcp 127.0.0.1:8770 ok        <-- healthy, wrong owner
[stack-integrity] log-window: DIRTY
  apply not clean: ... apply.complete | state="failed" durationMs=305667 ready=0 …
```

**Cause, filed as a P1 in `docs/native-todo.md`:** `bun --hot` re-evaluates the
module graph in the same process and tears nothing down, so every reload
constructs another `SystemOrchestratorService` and arms another `healthWatch`
while the previous one keeps ticking (`stopHealthWatch()` only runs on gateway
shutdown, which a hot reload never performs). Twelve `health-watch started`
lines accumulated in one process. Five of them then started a `whisper-stt`
child inside the same 10 ms:

```
17:15:09.229 native.started | service="whisper-stt" pid=46538
17:15:09.229 native.started | service="whisper-stt" pid=46537
17:15:09.231 native.started | service="whisper-stt" pid=46539
17:15:09.237 native.started | service="whisper-stt" pid=46540
17:15:09.239 native.started | service="whisper-stt" pid=46541
```

They signalled each other's children, lost the ownership record they all write to
the same pid file, and the survivors then read as foreign
(`native.port-held ... it is not a child of this gateway`) against pids whose
`ps -o ppid=` is the gateway itself. Eight
`reapply.gave-up reason="max-attempts-exhausted"` followed. It does not
self-heal — editing another source file adds a supervisor rather than recovering.

**Trigger, honestly: this task's own edits.** Six gateway source edits about
ten seconds apart, while a single apply takes twelve. Task 13 fixed
*"a successor process meets a predecessor's child"*; this is *"N supervisors
inside ONE process meet each other's children"*, which no pid file can arbitrate
because they all write the same one.

**State left behind:** whisper-stt is DOWN (`:8768` empty) and local-tts is up on
`:8770` as pid 50544 but unowned. A gateway **process** restart is required —
the agent's `kill` of the dev stack was refused by the permission system, so
this is left for the owner. `bun run dev` from the repo root after
`source scripts/env.sh`.
