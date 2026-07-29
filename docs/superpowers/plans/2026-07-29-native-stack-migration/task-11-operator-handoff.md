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
