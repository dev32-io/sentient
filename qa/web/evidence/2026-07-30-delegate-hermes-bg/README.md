# delegate-hermes-bg — the ORIGINAL failing drive (superseded; the row now PASSES)

> **CURRENT RESULT: PASS.** Read `RE-DRIVE-T9b.md` in this directory for the
> outcome that stands — the first real delegated completion in the project's
> history (5x `hermes-runner.run.ok`, 0x non-zero-exit). Both defects below were
> fixed in NM-T9b (`07e6d99`); the delegated agent's missing gateway TOOLS were
> a third, separate fault closed in NM-T9c (`36250cb`, socket off SIP-readonly
> `/run`) with one residual, D11, filed in `.superpowers/sdd/progress.md`.
>
> Everything below is the historical failing drive, kept because the two repro
> transcripts are the evidence for WHY the fixes look the way they do. It is not
> the current state of the row.

**Result at the time: BLOCKED on two real product defects, not a test-harness problem.**
Driven live via Playwright MCP against a real gateway + real hermes binary.
Full transcript: `gateway-log-excerpt.txt` (gateway) plus a direct
`hermes -p <userId> -z "..."` repro (bypasses the gateway entirely) below.

## Defect 1 — no code path creates the Hermes CLI profile for a new user

`gateway/src/api/handlers/auth.ts`'s `createFirstAdmin` carries this comment
(stale, describes the DELETED supervisord flow):

> Goes through the provisioner so the new admin gets the same materialization
> a regularly-created user does: slot binding, profile.json, **supervisord
> program with self-bootstrapping `hermes profile create` prefix**. Without
> this, first-admin would land in users.json only and the supervisord-spawned
> worker would BACKOFF until the next manual apply.

The native-stack migration deleted the supervisord daemon machinery (correct
— Hermes is no longer a managed service) but that daemon's *program spec*
was also the only thing that ever ran `hermes profile create <userId>`.
Nothing replaced it. Grepped the whole `gateway/src/` tree for
`profile create` / `profile-create` / `createHermesProfile` — the only two
hits are the stale comment above and a second comment in `user-id.ts`
describing the same dead mechanism. Confirmed live: a fresh admin account
created through the real setup wizard (`u_0417d3b0`) has a real gateway-side
render at `~/.sentient/gateway/u_0417d3b0/profiles/u_0417d3b0/` (SOUL.md,
config.yaml — `profile-store`'s job, which the migration correctly kept) but
**no** corresponding entry under Hermes's own CLI store,
`~/.hermes/profiles/u_0417d3b0/` — a different directory tree Hermes itself
owns. First `delegateTask` call:

```
2026-07-30T00:28:49.519 WARN [tools:hermes-runner] hermes-runner.run.non-zero-exit | userId="u_0417d3b0" code=1 elapsedMs=67 reasonLength=93
2026-07-30T00:28:49.519 WARN [tools:delegate-task] delegate-task.run.failed | taskId="17fae882…" agent="hermes" reason="Error: Profile 'u_0417d3b0' does not exist. Create it with: hermes profile create u_0417d3b0"
```

**Impact: `delegateTask` fails for every user on a fresh install, always**,
until an operator manually runs `hermes profile create <userId>` per user.
Worked around locally for the rest of this drive with exactly that command
(a one-time local CLI action, no source touched) — see the QA workaround
note at the bottom.

## Defect 2 — a freshly-created Hermes profile has no bound model/API key

After the workaround (`hermes profile create u_0417d3b0`), the SAME prompt
now reaches a real `hermes-runner.run.ok` (exit 0) but Hermes's own one-shot
response is a 401:

```
$ hermes -p u_0417d3b0 -z "Write a haiku about autumn leaves."
HTTP 401: User not found.
```

Reproduced **directly against the hermes binary, bypassing the gateway
entirely** — this is not a sentient-gateway wiring bug, it's genuinely an
unconfigured profile. Confirmed the rest of the pipeline is sound: an
existing, already-configured profile on this box (`default`, pinned to
`deepseek-v4-flash`) answers a one-shot prompt correctly in ~1s:

```
$ hermes -p default -z "Reply with exactly: HERMES DEFAULT OK"
HERMES DEFAULT OK
```

So `hermes profile create <userId>` alone is not sufficient — the old,
now-deleted bootstrap evidently did more than that one command (bound a
model + API key to the freshly created profile). That second step has no
current replacement either. **Did not attempt to read or copy any secrets
/ `.env` file to force this further** — `~/.hermes/profiles/<id>/.env`
exists but per this project's hard rule ("never read `.env`"), it was left
alone. This is a real, actionable gap for whoever owns the Hermes
provisioning side of user creation — both defects belong together (fix the
bootstrap once, fix both).

## Consequence — the `interrupt` background-cancel arm and `steer-followup-audio` are BLOCKED, not just this case

Both defects together mean a delegated task on this box resolves (with an
error) in ~1–2 real seconds, always — there is no way, in this environment,
to get a background task that is genuinely still running by the time a
*later* turn is replying (needed for `interrupt`'s background-cancel arm)
or that resolves *after* the dispatching turn's own final answer (needed
for `steer-followup-audio`). This is not a timing miss on the driving side;
it is structurally impossible until Defects 1+2 are fixed and a real,
credentialed Hermes call can run long enough to still be in flight a turn
or two later. Both rows are handed to Task 11 with this exact reasoning —
re-run once an operator has a working per-user Hermes profile.

## What DID get proven (the steering mechanism itself is sound)

The `session-runtime.submit.steer | kind="background-completion"` path
correctly folds a background completion — even an ERROR one — into the
SAME turn's ongoing react-loop while it's still running (`turnId` stays
constant across iterations; see `2026-07-30-steer-midloop/`). That's real,
positive evidence for `steer-midloop`'s core FSM, independent of whether
the payload itself is a success or a failure. See
`2026-07-30-steer-midloop/README.md` for what that same drive *also* found
(a second, distinct, in-repo defect).

## QA workaround used (local environment only, no source touched)

```
hermes profile create u_0417d3b0
```
Analogous to Task 8's `SENTIENT_CODE` staging-directory workaround: fixes
local dev-box STATE, not code, so the rest of the delegation pipeline could
be exercised for real instead of stopping at the very first defect found.
