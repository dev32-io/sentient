### Task 11: Operator handoff checklist

**Wave 6 · model: sonnet · spec §9.4 · THE FINAL ARTIFACT**

The plan is fully agentic until this document. Every other case has been executed to green by an agent. This task collects **only** what genuinely needs human hands or hardware, in a form the operator can act on in minutes without reconstructing context.

**Files:**
- Create: `docs/superpowers/handoffs/2026-07-29-native-migration-operator-checklist.md`

This task writes documentation only — no code, no tests. Its verification is that **every deferred item anywhere in the plan appears here exactly once**.

---

- [ ] **Step 1: Sweep the whole plan's execution for deferrals**

Collect every item Tasks 8, 9 and 10 handed off, plus anything their reports flagged as undrivable:

```bash
grep -rniE "handoff|operator|deferred|cannot be driven|not agent-drivable|BLOCKED" \
  /private/tmp/**/scratchpad/reports/*.md 2>/dev/null
grep -rniE "handoff|task 11" docs/superpowers/plans/2026-07-29-native-stack-migration/
```
Every hit is either in the checklist or was genuinely resolved. **A deferral that exists only in a report and not here is a process failure** — this document is the single place unverifiable work is allowed to live.

- [ ] **Step 2: Write the checklist with the four seeded items**

Each entry states: what to verify, **why an agent could not**, exact steps, expected observable result, and the exact log command + expected line. Structure:

```markdown
# Native Migration — Operator Verification Checklist

Everything else in this plan was executed and verified by an agent, to green.
These four need physical hardware or a second machine. Expect ~15 minutes.

Log helper used throughout:
    tail -f ~/.sentient/gateway/logs/$(date +%F).log

---
## 1. Acoustic barge-in (web)
**Why not an agent:** headless Chromium has no microphone. Fake-device flags
inject a file, which does not reproduce acoustic echo through a real speaker —
and echo behaviour is the actual thing under test.

**Steps**
1. Open the webui, enable voice, ask something with a long answer.
2. While the assistant is speaking, speak over it.

**Expect (visible):** audio stops within ~200 ms; the partial reply stays in the
feed marked as cut off; any background task keeps running.

**Expect (log):**
    grep -E "turn.aborted|playback.stop" ~/.sentient/gateway/logs/$(date +%F).log | tail -5
    → turn.aborted with cutoff="barge-in", followed by playback.stop

**If it fails:** note whether audio kept playing (client queue not flushed) or
the turn kept generating (server abort not reached) — they are different bugs.

---
## 2. Acoustic barge-in (physical phone)
**Why not an agent:** simulators have no real audio path; the `physical-only`
Maestro tag exists for exactly this.

**Steps:** same as #1 on a real Android or iOS device, on the LAN.
**Expect:** identical behaviour; the client audio queue flushes and does not resume.

---
## 3. LAN-exposure negative check from another device
**Why not an agent:** the agent probed the LAN IP from the mini itself, which
proves the bind. Proving unreachability *from elsewhere* needs a second machine.

**Steps** — from a laptop on the same LAN, with MINI_IP set:
    for p in 8086 8668 8087 8080; do
      echo -n "port $p: "; curl -s -m 3 -o /dev/null -w "%{http_code}\n" "http://$MINI_IP:$p/" || echo refused
    done
    curl -sk -o /dev/null -w "gateway: %{http_code}\n" "https://$MINI_IP:8888/api/v1/health"

**Expect:** every addon port refused; the gateway answers 200.
**If any addon answers:** a `ports:` entry is missing its `127.0.0.1` prefix.
This is a live LAN exposure — fix before the branch merges.

---
## 4. Echo-cancellation quality under real acoustics
**Why not an agent:** subjective, and dependent on room, mic and speaker.

**Steps:** hold a normal spoken conversation at a comfortable volume.
**Expect:** the assistant does not barge-in on its own TTS output.
```

- [ ] **Step 3: Append everything discovered during execution**

Add every item collected in Step 1, in the same shape. Likely candidates based on the plan: `05-interrupt.yaml`'s real interrupt tap if local-tts proved unreachable from the emulator (Task 10 Step 7), and any row Task 9 could not make green for hardware reasons.

- [ ] **Step 4: Record scope-blocked items SEPARATELY**

The operator must be able to tell "needs your hands" from "needs more code". Add a clearly separated section:

```markdown
---
# Not in this checklist — blocked by scope, not by hardware

These need code that is deliberately out of scope for this project. No operator
action; recorded so they are not mistaken for gaps in the verification above.

- **session-switch / past-chat rows** — need the sessions REST surface
  (`GET /sessions/:id/messages`) and the `sessions.*` frames. Multi-conversation
  is a later project. Reload and reconnect within ONE conversation ARE verified.
```

- [ ] **Step 5: Verify the invariant — every deferral appears exactly once**

Cross-check the Step 1 list against the finished document: each item present, none duplicated, none dropped. State the count in your report.

- [ ] **Step 6: Commit**

```bash
git commit -m "docs(handoff): operator verification checklist for the native migration" -- \
  docs/superpowers/handoffs/
```

---

## Addendum — deferrals already accumulated

The Step 1 sweep must find these. They are listed here so a missing one is a detectable failure rather than a silent loss. Confirm each is still open before writing it up — several may have been closed by a later wave.

**Needs the operator's hands or a second machine** (goes in the main checklist):

1. **`code-immutability`** — the root-owned-code negative check. Requires an interactive `sudo` the agent has no non-interactive path to. Steps: as the service user, attempt to write into `/opt/sentient/<version>/`; expect `Permission denied`.
2. **`offline-install`** — install with networking disabled, proving the vendored wheels actually satisfy every dependency. Needs a real network-off toggle.
3. **The root-only half of `upgrade-rollback`** — the agent verified the health-gate and the rollback logic; the privileged symlink flip needs root.
4. **A pre-existing `whisper-stt` config on the mini binds `0.0.0.0`.** Task 8b fixed the *shipped example*; an install that predates it keeps the old live value, so the mini is exposing STT on the LAN until edited. Path: `~/.sentient/whisper-stt/config/config.yaml`, key `host`, set to `127.0.0.1`, then restart the addon. **Give this one its own numbered entry with a "do this first" marker — it is a live exposure, not a verification.**
5. Whatever Task 10 hands over (acoustic cases, `05-interrupt.yaml`'s real tap if local-tts proved unreachable from the emulator, any `physical-only` row).
6. **`steer-followup-audio`'s audio half**, if Task 9c could not drive it — the WS-seam harness negotiates no `audio.output`, so a real browser session is needed. Include Task 9c's exact stated reason, not a paraphrase.

**Blocked by scope, not hardware** (goes in the separate Step 4 section — no operator action):

7. **Signal pairing** — the runner was removed outright in Task 6b as dead weight. Not a gap; there is nothing to verify.
8. **The Hermes-shaped settings — soul, personality, long-term memory — are expected-inert on 2.0.** The gateway now owns the agent loop, so those surfaces render and persist but do not change behaviour. The owner's decision: keep the UI, transition the functionality to gateway-owned in a later spec. Say this plainly — an operator who tests personality and finds it does nothing must be able to tell "as designed, for now" from "broken", and this is the single most likely thing for them to trip over.
9. **session-switch / past-chat rows** — the seeded entry above already covers these.
10. **OPEN DEFECT D11 — the delegated Hermes agent has no gateway/HA/MA/searxng tools on a fresh
    install.** Not a verification gap and not out of scope: a real functional defect that is
    re-scoped into its own task body, `task-9d-hermes-profile-bridge.md`, and deliberately **blocked
    on an owner decision** (does a delegated sub-agent inherit the delegator's whole tool catalog, or
    only the gateway MCP?). `delegateTask` itself works — it dispatches, runs a real credentialed
    hermes and returns a real completion — so an operator sees delegation succeed while the delegated
    agent is toolless. Say that distinction plainly, the same way item 8 separates
    "as designed, for now" from "broken". Containment already shipped: `hermes-profile.bridge.not-live`
    WARNs once per user on every boot (`grep` it in `~/.sentient/gateway/logs/`). Full record:
    `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` § D11.

- [ ] **Step 7: Lead with the one thing that is not a verification**

Item 4 changes a live security posture; everything else confirms work already done. Put it first, under its own heading, so an operator who reads only the top of the document still does the thing that matters.
