# NM-T9c — verification gaps closed, and the two that stay open

Companion to `../2026-07-30-delegate-hermes-bg/`. Written by NM-T9c after fixing D8/D9/D7/D10.
Rows are recorded here exactly as they stand; nothing is flipped on partial evidence.

---

## Step 13 — stale BLOCKED headers corrected

`../2026-07-30-delegate-hermes-bg/README.md` opened `**Result: BLOCKED on two real product
defects**` while its own companion `RE-DRIVE-T9b.md` recorded PASS. A reader hitting the README
first got the wrong answer. Its header now says PASS, points at the re-drive, and marks the body as
the historical failing drive kept for its repro transcripts.

`.superpowers/sdd/progress.md` is append-only history, so its old BLOCKED lines were NOT rewritten
— rewriting them would falsify the record of what was true at the time. A dated correction block is
appended at the tail instead.

---

## Step 14 — `interrupt`'s background-cancel arm: primitive PROVEN, browser row NOT flipped

The arm is a four-link chain. Three links were already pinned by unit tests; the fourth — does a
cancel handle actually kill the real hermes **subprocess** — was not, and "the turn aborted" is not
evidence for it.

| Link | Status | Evidence |
|---|---|---|
| UI Stop -> `interrupt` -> `broker.background.cancelAll()` | pinned | `session-runtime.test.ts:801` (`cancelAllCalls === 1`), plus the contrast case at `:756` proving **barge-in never calls it** |
| `cancelAll()` -> every registered `cancel()` | pinned | `background-registry.test.ts:27`, incl. continuing past a throwing handle |
| `delegateTask`'s `cancel` -> `controller.abort()` | pinned | `delegate-task.ts:121` |
| abort -> `proc.kill()` -> **the OS subprocess is gone** | **PROVEN THIS TASK** | real-process run below |

Driven against the real `hermes` binary and the real `createHermesRunner` (no fake `spawn`), with a
long prompt so a task was genuinely in flight when the cancel landed:

```
[before] hermes pids for u_885ffeb7: []
[during] hermes pids: ["79522"]
[abort] firing cancel() -> controller.abort()
[result] {"ok":false,"error":"aborted"}
[after]  hermes pids: []
PASS: every hermes subprocess started by the run is gone after cancel
```

**The matrix row stays UNFLIPPED.** What fired the cancel here was `controller.abort()` — exactly
what `delegateTask`'s cancel handle does — not a click on the webui Stop button. The trigger link is
unit-pinned, not browser-driven, and this task could not obtain an authenticated WS/browser session
(see the blocker below). What is now closed is the substantive doubt T9b left: cancellation reaches
the subprocess. Whoever drives the browser row inherits a chain with no unproven link in it.

---

## Step 15 — `steer-followup-audio`: the AUDIO half remains unverified. NOT flipped.

T9b verified the **steer / new-bubble** half against the real model and it PASSES
(`RE-DRIVE-T9b.md`): a background completion resolving after the dispatching turn's final answer
started a genuine back-to-back turn, `trigger="background-completion"`, and the chain terminated
instead of running away.

The row's other assertion — *"audio queues behind the still-playing turn"* — is **NOT verified, and
must not be marked green on the text half.** Exact reason:

- T9b drove the row over the raw gateway WS seam (`auth` -> `session.configure` -> `text.input`,
  reading `turn.*` / `delegation.progress`). That driver never negotiates `audio.output`, so the
  gateway had no reason to open a TTS downlink and there was no audio queue to observe. The absence
  of audio frames there is a property of the harness, not of the product.
- Verifying it needs a client that actually negotiates `audio.output` and can observe playback
  ordering across two turns: a real browser (Playwright, with the composer + TTS enabled) or a
  Maestro-driven mobile app. Both need an authenticated session.

**Handoff to T11 / T10:** drive one delegated request that completes AFTER the dispatching turn's
final answer, with TTS on, and assert the follow-up turn's audio starts only after the first turn's
audio finishes. Mobile is the better surface — the KMP SDK's downlink is lazy-armed on `audio.start`
(see `project_mobile_stt_capture_and_filter_audit`), so ordering is observable there.

---

## The blocker both open rows share

Driving either row needs an authenticated session, and this task had no PIN for any of the three
local users (`Ada`, `Grace`, `Delegate Proof`). `POST /api/v1/admin/users` needs an admin PASETO
session token, which needs a PIN — circular. PIN guessing was not attempted.

One-line unblock for whoever holds a PIN, or can create a user through the wizard:

```bash
# then drive: auth -> session.configure {audio.output} -> text.input "ask hermes to …"
curl -sk https://127.0.0.1:8888/api/v1/auth/login -X POST \
  -H 'content-type: application/json' -d '{"userId":"<id>","pin":"<pin>"}'
```

This is an environment obstacle, not a product defect. Every product fault these rows were
*originally* blocked on is fixed and independently evidenced. One fault found DURING this task is
not fixed — D11 below.

---

## D11 (OPEN, FUNCTIONAL) — the delegated agent has no gateway/HA/MA/searxng tools, for any user

**This is the tracked record for D11.** It is not a residual of a closed defect: it is the still-open
cause of the same symptom the `delegate-hermes-bg` chain has now chased twice (D5 → D8 → D11). The
socket half was necessary and is fixed; this half is not, and nobody has decided how to fix it.

### Symptom, measured
Ask the delegated agent what it can call:

```
cd ~/.sentient/gateway/u_885ffeb7/profiles/u_885ffeb7
hermes -p u_885ffeb7 -z "List the exact names of every tool you can call…"   EXIT=0
-> 28 tool names, ALL hermes builtins (browser_*, terminal, memory, delegate_task, …)
   grep -cE 'identify_user|pause_audio|resume_audio|update_user_settings' -> 0
   no ha_*, no ma_*, no searxng, no fetch
```

### Root cause, proven with hermes's own public API
```
$ hermes profile show u_885ffeb7
Path:    /Users/kevinye/.hermes/profiles/u_885ffeb7     <-- what hermes READS
Model:   deepseek-v4-flash (ollama-cloud)               <-- the --clone-from SOURCE's model
```
- The gateway renders `mcp_servers` + `enabled_toolsets` + SOUL.md into
  `getHermesProfileDir(userId)` = `~/.sentient/gateway/<userId>/profiles/<userId>/`.
- Hermes reads `$HERMES_HOME/profiles/<userId>/`. With `HERMES_HOME` unset that is its own default
  store, which has neither `mcp_servers` nor `enabled_toolsets` (grepped, not printed — mode 600).
- The two trees were bridged by `HERMES_HOME` in the **supervisord program env**, one value per
  per-user container. The native cutover deleted the daemon; `tools/hermes-runner.ts` spawns with
  `cwd` but no `env`. So the gateway's whole rendered profile is dead output.
- Corroboration: that run's `logs/agent.log` contains no `mcp` or `toolset` line at all — hermes
  never attempted to load an MCP server.

### What 36250cb DID fix, and why it is not sufficient
The per-user MCP socket used to be configured under `/run`, which is SIP-read-only on macOS, so it
could never open natively. That is fixed (`~/.sentient/run/mcp-<userId>.sock`) and proven end-to-end
— but only **after registering the MCP by hand**:

```
$ hermes -p u_885ffeb7 mcp add gateway --command nc --args -U ~/.sentient/run/mcp-u_885ffeb7.sock
  ✓ Connected! Found 4 tool(s): identify_user pause_audio resume_audio update_user_settings
$ hermes -p u_885ffeb7 -z "Call the identify_user tool with name 'Kevin'…"
  **Tool called:** `mcp__gateway__identify_user`  ->  known users: Ada, Grace, Delegate Proof
```
Those names exist only in the gateway's user store, so the RPC genuinely crossed the moved socket.
The socket works; nothing in the product registers it.

### Two fixes that look obvious and are wrong
1. **Point `HERMES_HOME` at the gateway tree** (plist/env). Loses the delegated agent's credentials:
   the rendered dir has no `.env` and no `auth.json`, which is exactly what `--clone-from` solved in
   T9b, and writing those ourselves violates the standing "no Hermes internals from the adapter"
   rule. **And structurally it cannot work anyway** — `HERMES_HOME` is ONE process-wide variable
   while the rendered root is PER-USER, so a single value is correct for at most one family member.
   The per-user `HERMES_HOME` model died with the per-user container.
2. **Have the gateway write into `~/.hermes/profiles/<userId>/` directly.** Same rule violation, and
   it makes the gateway the co-owner of hermes's own store.

### The route that IS proven by hand (hermes's public API, boundary intact)
```bash
printf 'y\n' | hermes -p <userId> mcp add gateway --command nc --args -U <resolveMcpSocketPath(userId)>
hermes -p <userId> mcp list      # -> gateway | nc -U /Users/…/mcp-<userId>.sock | all | ✓ enabled
```
Natural home: `gateway/src/admin/hermes-profile-provisioner.ts`, right after `profile create
--clone-from`, driven off `config.yaml#mcp_catalog` + `resolveMcpSocketPath`. The boot backfill
already re-runs the provisioner for every existing user, so it would backfill for free.

### Why it is NOT implemented — an escalated decision, reserved for the human
Two questions the task never scoped, both of which change what ships:
- **When:** register once at provision, or reconcile on every profile change / every boot?
- **What:** the gateway MCP only, or the user's whole enabled `mcp_catalog` (HA, MA, searxng, fetch)
  — i.e. does a delegated sub-agent inherit the delegator's full tool authority? That is a
  capability-scope question, not a wiring one.
An agent picking either would be committing an architectural/security decision the implementer
deliberately declined to make. It stays open on purpose.

### Fail-loud guard now in place (`092083c`)
The shape may ship, but not silently. `gateway/src/admin/hermes-profile-bridge.ts` detects the
missing bridge and the provisioner logs it once per user on create AND on every boot backfill:

```
2026-07-30T04:57:33.483 WARN [gateway:admin:hermes-profile] hermes-profile.bridge.not-live |
  userId="u_1eee01a4" reason="hermes-home-unset"
  renderedRoot="/Users/kevinye/.sentient/gateway/u_1eee01a4" hermesHome=null defect="D11"
  consequence="rendered mcp_servers/enabled_toolsets are dead output; the delegated agent gets no gateway MCP tools"
```
Live-verified in the real gateway log for all three local users, on two consecutive boots.
`grep hermes-profile.bridge.not-live ~/.sentient/gateway/logs/$(date +%F).log` is the check.

### What T10 (and any delegation drive) must know
- `delegateTask` **works** — it dispatches, runs a real credentialed hermes, and returns a real
  completion. Rows about dispatch, steering, follow-up turns and cancellation are drivable.
- The delegated agent **has no gateway/HA/MA/searxng tools out of the box**. Do not write a native
  case that asserts a delegated agent used a gateway tool, and do not file a new defect when one
  cannot — it is this one. Equally, do not let such a case pass *vacuously*: if a flow only asserts
  "a reply came back", it proves nothing about tool access.
- **Local-dev state warning:** `u_885ffeb7` on this machine had `mcp add` run by hand, so that ONE
  user's delegated hermes does have the 4 gateway tools. `u_0417d3b0` (Ada) and `u_1eee01a4` (Grace)
  do not. That is machine state, not code — a fresh install has zero.

### Smaller residuals recorded with it
- **No INFO-level trace of a delegated tool call.** `mcp-host:unix-listener` logs open/close and
  `mcp-server` logs `tools/call` at DEBUG; the live level is `info`. The migration's own acceptance
  criterion therefore leaves no evidence in a default-configured log. One INFO line on `tools/call`
  at the per-user socket boundary would close it.
- **`MCP_SOCKET_DIR` in `bootstrap/phase-orchestrator.ts:119` is dead** — zero readers repo-wide; it
  fed the deleted `sentient-hermes` container's bind mount and its comment still describes it.
- **`hermes.mcp_host.socket_path` and `mcp_catalog.gateway.args` are still two places** spelling the
  same path. Cross-referenced by comment; nothing mechanically enforces agreement. Deriving the
  catalog arg from `resolveMcpSocketPath` (which the D11 fix would do anyway) closes it.
