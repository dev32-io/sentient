# Native-restart local-tts hang — real, reproducible, currently blocking TTS

**Found while driving `restart-persistence` / `compaction-continue`, not a
named case of its own — filing it here since it's a genuine, serious
defect discovered by running the real stack, exactly what E2E is for.**

## What happened

Restarted the real gateway process (needed anyway to pick up the
`compact_threshold_tokens` config edit — see
`../2026-07-30-restart-persistence/README.md`). Boot sequence:

```
00:56:10.577 native.orphan-reaped | service="local-tts" pid=83475
00:56:10.620 [system-orch:orchestrator] apply.start | targets=…,whisper-stt,local-tts mode="all"
  … docker services recreate fine …
00:56:18.831 native.started | service="whisper-stt" pid=15466
                                                                    ← NOTHING for local-tts after this. Ever.
```
No `native.started`, no `native.prepare-failed`, no `native.spawn-failed`,
no `apply.complete` — the whole `applyAll()` promise chain for this boot
appears to just stop after `whisper-stt` starts. **5+ real minutes of
total silence** (00:56:18 → 01:03+, when this was written), gateway CPU
usage over that whole window: 4.5s (idle, not spinning — a hung `await`,
not a busy loop). Because `apply.complete` never fires, `health-watch`
(the periodic self-heal T8b built) never even starts for this boot — there
is currently **no active recovery mechanism running at all**. TTS is fully
dead for the whole session until an operator manually restarts again.

## Ruled out (so this isn't a false lead)

1. **Not the command itself.** Ran the exact same launch
   (`<staging>/local-tts/venv/bin/python -m local_tts`, same cwd) directly
   from a shell, bypassing the gateway entirely: ready in **~3 seconds**
   real time, clean model load, clean shutdown on SIGTERM. The staged
   venv, the model cache, the interpreter are all healthy.
2. **Not a port conflict.** `lsof -nP -iTCP:8770 -iTCP:8771` — nothing
   listening. `ps` for `local_tts` — no process at all, not even a zombie.
   Nothing is silently holding the port; the child was simply never
   (successfully) spawned.
3. **Not a repeat of the earlier known issue.** This is a *different*
   local-tts problem than the legacy-LaunchAgent port squatting documented
   in Task 8/T9's bring-up notes — those ports are provably free here.

## Narrowed to (not fixed — `gateway/src/system-orchestrator/**` isn't in T9's file ownership)

`native-driver.ts`'s `spawnService()` sequence is
`verifyLaunchArtifact()` (interpreter executable check + a pinned-Python
version probe via `execFile(..., {timeout: VERSION_PROBE_TIMEOUT_MS})`,
which itself resolves to `null` + a WARN log on timeout, never hangs
silently) → `stopIfRunning()` (no-op on a fresh boot registry) →
`deps.spawn(...)` (`Bun.spawn` with `detached: true`) → `native.started`
log. Since NO log fires between `whisper-stt`'s success and the silence
(not even the interpreter-probe's own timeout/failure warning, and not
`native.prepare-failed`), the hang is most likely inside the actual
`deps.spawn(...)` call for `local-tts` specifically — the second native
service started in the same boot `apply.start` batch, immediately after
`whisper-stt`'s own spawn. Whether this is a `Bun.spawn`
concurrency/ordering issue when two `detached: true` process-group spawns
land back-to-back in the same reconciler pass, or something specific to
this service's `env`/`cwd` under a repeat boot, needs someone with
`gateway/src/system-orchestrator/**` ownership to instrument
`spawnService()` directly (the black-box evidence above is as far as a
QA-only investigation can responsibly go without adding logging to source
that isn't mine to add).

## Reproduction count — 2 of 2 consecutive restarts, not a one-off

Attempted recovery via a second full restart (kill + relaunch). Same
hang, same shape: `native.started | service="whisper-stt"` then total
silence for local-tts, confirmed no progress after 140+s this time
(re-checked at +90s past whisper-stt's start with a dedicated wait — still
nothing). So this is **2 of 2** on the most recent consecutive restarts,
not a one-off race recovered by retrying — the earlier draft of this note
said "a second restart recovered it," which was wrong (written before
waiting long enough to see the SAME restart hang too; corrected here
rather than silently fixed). The very first restart of this session
(much earlier, before `compact_threshold_tokens` was touched) DID start
both native services fine within ~9s — so it is not "always hangs since
boot," but it is not "recovers on retry" either. Left local-tts down for
the remainder of this drive rather than burn more time chasing an exact
trigger that isn't mine to fix; the rest of the case matrix that doesn't
depend on TTS (multi-user-isolation, the text/log-trail half of
compaction-continue) continued without it.

## Why this matters beyond this session

The design's own resilience story (T8b: post-boot health watchdog) is
predicated on `apply.complete` firing so `health-watch` can start. This
hang defeats that story at its root — a boot that never completes leaves
the box with **no self-heal running**, silently, with nothing in the logs
past `native.started | service="whisper-stt"` to even hint something is
wrong. On the production Mac mini under `launchd`, this would present as
"TTS is just dead after a restart, forever, until someone notices and
kicks it again" — worth a P1 look before this migration ships.
