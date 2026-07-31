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

- `drive-1-at-boot.txt` — live stack, gateway boot of 14:12:58 (apply 14:13:12).
- `drive-2-after-restart.txt` — same oracle re-driven after a deliberate gateway restart.
- `negative-control.txt` — the oracle proving it can fail, run against
  `qa/web/fixtures/stack-integrity-negative-control.yaml`.

## Result

| Drive | Pre-state | Expected user-visible | Actual |
|---|---|---|---|
| 1 (at boot) | stack up since 14:12:58 | 9/9 declared services PASS, log window clean | `RESULT PASS — pass=9 fail=0 skip-optional=0 of 9 declared`, exit 0 |
| 2 (after restart) | gateway restarted, addons re-applied | 9/9 PASS again, new pids matched | see `drive-2-after-restart.txt` |
| negative control | fixture declares 3 services that are absent / impostor | exit 1, one FAIL per gate | `RESULT FAIL — pass=0 fail=2 skip-optional=1 of 3 declared`, exit 1 |

**The negative control is the part that matters.** Its third row reproduces the
exact shape of the bug that hid for a branch:

```
  FAIL           qa-port-impostor (native)
      running  pid 28031
      identity IMPOSTOR OR ORPHAN: :8086 held by [1508], orchestrator recorded 28031
      health   tcp 127.0.0.1:8086 ok        <-- a HEALTHY probe
```

`health` is green and the case still fails, because the process answering is not
the process the orchestrator recorded. Under the old oracle that row was a pass.

## Log trail (drive 1)

```
2026-07-31T14:13:06.904 INFO [system-orch:native-driver] native.started | service="whisper-stt" pid=18803 argc=3
2026-07-31T14:13:10.037 INFO [system-orch:native-driver] native.started | service="local-tts"  pid=18859 argc=3
2026-07-31T14:13:12.105 INFO [system-orch:orchestrator] apply.complete | state="ready" durationMs=12798 ready=9 degraded=0 failed=0 blocked=0
```

`lsof -nP -iTCP:8768 -sTCP:LISTEN -t` → `18803`; `:8770` → `18859`. Recorded ==
listening, on both.
