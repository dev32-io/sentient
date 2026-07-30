# Native Migration — Operator Verification Checklist

Everything else in the native-stack migration was executed and verified by an agent, to green.
What is left here is what an agent physically, legally or credentially could not do: it needs your
hands, a second machine, real `sudo`, a real microphone, or your PIN.

**Read §0 first.** Every other section *confirms* work that is already done. §0 **changes** a live
security posture, and if you read nothing else, do that one.

**Time:** §0–§1 and §6–§13 take about 25 minutes total. §2–§5 are one sitting at the Mac mini during
the first real `sudo` install — budget 30 minutes for that separately.

**Log helper, used throughout:**

```bash
tail -f ~/.sentient/gateway/logs/$(date +%F).log
```

Log timestamps and the daily-rotation boundary are **local time**, not UTC — `date +%F` is right and
`date -u +%F` will hand you yesterday's file for a few hours either side of midnight.

**How to read a section.** Each one says what to verify, *why an agent could not*, the exact steps,
what you should see, and the exact log command with the line to look for. If something fails, the
"If it fails" note tells you which of two different bugs you are looking at — they are never the same
bug, and guessing wrong wastes an hour.

**Two things that are NOT bugs**, called out up front because they are the most likely things to be
misfiled (both are explained in full at the bottom): the **soul / personality / memory** settings do
nothing to the assistant's behaviour on 2.0 *by design*, and the **multi-conversation** parts of the
app (new chat, chat history, switching, rename/delete) are deliberately unfinished.

---

# §0 — Do this first. This one is a CHANGE, not a verification.

## 0. `whisper-stt` may still be listening on every network interface

Speech-to-text ships bound to loopback (`127.0.0.1`) so only the gateway on the same machine can
reach it. That was fixed in the *shipped example* config during this migration — but the example is
only copied when a config does not already exist. **Any machine that installed whisper-stt before
the fix keeps its old `host: 0.0.0.0`**, which means your live microphone stream service is
reachable from every device on your LAN until you edit one line.

Verify this is still true on the mini before assuming either way — the dev machine was already
corrected by hand during the migration, and whether the mini's install predates the fix depends on
when whisper-stt was first installed there.

**Why not an agent:** two reasons. Production is observational-only for agents — they are not
permitted to mutate state on the mini. And no code change can fix it: the config reconciler is
additive-only *by design* (it fills in missing keys and never overwrites an existing one, which is
what protects your model pin and your tuned constants), so an already-seeded box keeps `0.0.0.0`
forever. Special-casing one key would erode the no-clobber contract that protects everything else.

**Steps** — on the Mac mini:

```bash
grep -n 'host:' ~/.sentient/whisper-stt/config/config.yaml
```

- If it shows `host: 127.0.0.1` → nothing to do, move to §1.
- If it shows `host: 0.0.0.0` → edit that one value to `127.0.0.1`, then restart.

Restart depends on what supervises whisper-stt on that box. Check first:

```bash
launchctl list | grep -i sentient
```

- If you see `io.sentient.gateway` (the native-migrated shape — the gateway spawns whisper-stt as its
  own child process):
  ```bash
  sudo launchctl kickstart -k system/io.sentient.gateway
  ```
- If you see `io.dev32.sentient.whisper-stt` (the older standalone LaunchAgent shape):
  ```bash
  launchctl kickstart -k gui/$(id -u)/io.dev32.sentient.whisper-stt
  ```

While you are there, the same check on TTS costs nothing — it has always shipped correct, but confirm:

```bash
grep -n 'host:' ~/.sentient/local-tts/config/config.yaml
```

**Expect (observable):**

```bash
lsof -nP -iTCP:8768 -sTCP:LISTEN
```
→ `127.0.0.1:8768 (LISTEN)`. If it says `*:8768`, the service is still on every interface.

**Expect (log):**

```bash
grep -E "stt.connecting|stt.connected" ~/.sentient/gateway/logs/$(date +%F).log | tail -5
```
→ `stt.connecting` then `stt.connected` after the restart. If STT never connects, you changed the
host but the gateway is still dialling the old address — the gateway's `stt.url` in
`~/.sentient/gateway/config.yaml` must be `ws://127.0.0.1:8768`.

**If it fails:** a service that will not start after the edit is almost always a YAML indentation
mistake — `host:` sits under `server:`, indented two spaces. Check
`~/.sentient/whisper-stt/logs/` for the parse error before suspecting anything else.

---

# Part 1 — needs your hands

## 1. Prove the addons are unreachable from another device (5 min, second machine)

Every addon is supposed to publish on `127.0.0.1` only; the gateway itself is the one thing that
should answer from the LAN. An agent already probed the mini's LAN IP *from the mini*, which proves
the bind is correct locally — but a loopback bind and a LAN bind look identical from the same host.

**Why not an agent:** proving something is unreachable *from elsewhere* requires a second machine on
the same network. The agent had one host.

**Steps** — from a laptop on the same LAN as the mini:

```bash
MINI_IP=<the mini's LAN IP>

# docker addons: ha-mcp, ma-mcp, and the two ingress-proxy listeners
for p in 8086 8668 8087 8088; do
  echo -n "docker $p: "; curl -s -m 3 -o /dev/null -w "%{http_code}\n" "http://$MINI_IP:$p/" || echo refused
done

# native addons: whisper-stt WS + health, local-tts WS + health
for p in 8768 8769 8770 8771; do
  echo -n "native $p: "; curl -s -m 3 -o /dev/null -w "%{http_code}\n" "http://$MINI_IP:$p/" || echo refused
done

# the gateway itself, which SHOULD answer
curl -sk -o /dev/null -w "gateway: %{http_code}\n" "https://$MINI_IP:8888/api/v1/health"
```

**Expect:** all eight addon ports print `refused` (or `000`, curl's code for no connection). The
gateway prints `gateway: 200`.

**If a docker port answers:** a `ports:` entry in `gateway/templates/services/*.yaml` is missing its
`127.0.0.1:` prefix. That is a live LAN exposure — fix before the branch merges.

**If `8768` or `8769` answers:** §0 was not done, or was done and not restarted. Go back to §0.

**If the gateway does NOT answer 200:** that is not an exposure problem, it is a gateway problem —
check `launchctl print system/io.sentient.gateway | grep -E "state|path"`.

---

## §2–§5: the first real `sudo` install on the mini — one sitting

These four all need genuine root on the production machine. The agents that built and tested the
installer had no `sudo` on their box (verified independently by three of them: `sudo -n true` refuses,
no cached credential, no askpass helper), so every root-only branch was proven through a rootless
substitute harness that stubs exactly two operations — `launchctl` and `chown` — and runs everything
else for real. What is left is those two operations.

Do §2–§5 together during the first real install; they share the same setup.

## 2. `code-immutability` — installed code must be root-owned and unwritable

**Why not an agent:** the entire assertion *is* root ownership. There is no rootless substitute that
could prove it — faking the ownership would make the test prove nothing.

**Steps** — after `sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<version>.tar.gz`:

```bash
ls -ld /opt/sentient /opt/sentient/current/
touch /opt/sentient/current/should-not-work
```

**Expect:** `/opt/sentient/**` shows `root  wheel` and mode `drwxr-xr-x`. The `touch` fails with
`Permission denied` when run as your normal (non-root) user.

**If the touch succeeds:** the install ran without the ownership pass, or `/opt/sentient` was created
by hand earlier and inherited your uid. Re-run the installer and re-check `ls -ld`.

---

## 3. `upgrade-rollback` — the privileged half

The installer's own logic is fully proven: checksum verification, the TLS health-gate, automatic
rollback when the gate fails, idempotent re-install, version pruning, and config preservation all ran
for real against a real built release
(`deploy/mac-prod/tests/e2e-install.sh`, 7/7 sub-cases green; transcript in
`qa/native/evidence/2026-07-29-upgrade-rollback/`).

**Why not an agent:** the real run needs root twice over — `chown -R root:wheel` on the release tree,
and the `system` launchd domain with a `UserName` switch. Both were stubbed in the harness.

**Steps:** install version A, then install version B, then force a rollback by installing a version
whose health-gate cannot pass.

```bash
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<versionB>.tar.gz
ls -l /opt/sentient/current                    # symlink target
launchctl print system/io.sentient.gateway | grep -E "state|username|path"
curl -sk https://localhost:8888/api/v1/health
```

**Expect:** `current` points at version B, the job is `running` under the service account, health
returns `{"status":"ok"}`. On a failed health-gate, `current` reverts to version A **and version A
comes back healthy** — a rollback that leaves the box down is the failure mode that matters.

**Expect (log):**

```bash
grep -E "store.opened|migrate" ~/.sentient/gateway/logs/$(date +%F).log | tail -10
```

**While you are rolling back, watch for one specific line.** There is exactly one code path in the
whole migration that was never executed, and a rollback is the only thing that executes it: when an
*older* gateway opens a per-user database that a *newer* gateway already migrated forward, it is
supposed to WARN and leave the database untouched rather than damage it. That branch is covered by
reasoning only. During the rollback above, grep for a warning naming a schema version ahead of the
binary's own, and confirm the gateway still starts and still serves your chat history. If it instead
starts modifying the database, stop and report it — that is data loss, not a startup warning.

**If it fails:** distinguish "the health-gate never fired" (the new version was accepted while
unhealthy — a gate bug) from "the gate fired but the revert did not restore service" (a rollback
bug). They are different defects and the log ordering tells you which.

---

## 4. `offline-install` — nothing may be fetched at deploy time

Python dependencies are supposed to install exclusively from vendored wheels, so the mini needs no
PyPI access, ever.

**Why not an agent:** it needs the same root as §3, *and* a real network-off toggle. The agent
deliberately refused to run `networksetup -setairportpower en0 off` — that is a machine-wide action
on your own dev box which could sever the agent's own connectivity with no way to self-recover, for
a check already blocked on `sudo` anyway.

The structural half is already proven: `deploy/mac-prod/native/install-venv.sh` uses
`pip install --no-index --find-links=`, which makes network fetching impossible regardless of network
state, and a real offline whisper-stt venv build (44 wheels) was run for real. What is unproven is
the literal case.

**Steps** — on the mini, after §3:

```bash
networksetup -setairportpower en0 off     # or unplug ethernet
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<version>.tar.gz
networksetup -setairportpower en0 on
```

**Expect:** the install completes normally. No pip timeout, no DNS error, no "retrying" lines.

**If it fails:** read *what* it tried to fetch. A missing wheel is a lockfile gap (fix:
re-run the wheel-vendoring script for that service); a docker image pull is a different problem
entirely — the addon images must already be baked locally.

---

## 5. Restart the gateway twice and confirm BOTH native services come back

This is the highest-risk unknown in the whole migration, and the mini is the only place it can be
tested.

During E2E an agent hit a **reproducible hang (2 of 2 consecutive restarts)** where, on gateway
restart, `whisper-stt` started fine and `local-tts` then produced *no log line at all* — not started,
not failed, nothing — and the boot sequence simply stopped. Because the boot never completes, the
post-boot health watchdog never starts either, so **nothing self-heals**. On the mini under launchd
this would present as "TTS is just dead after a restart, forever, until someone notices." Full
investigation: `qa/web/evidence/2026-07-30-native-restart-tts-hang/README.md`.

**Why not an agent:** it has not been reproducible on the dev machine since, because the dev gateway
runs without `SENTIENT_CODE` set and therefore never supervises the native services at all. The
production launchd plist *does* set it. The mini is the only environment where this path runs for
real. No fix has landed — no commit has touched the orchestrator's native driver since the hang was
found — so treat it as live until this check says otherwise.

**Steps** — on the mini:

```bash
sudo launchctl kickstart -k system/io.sentient.gateway
sleep 45
grep -E "native.started|native.prepare-failed|native.spawn-failed|apply.complete" \
  ~/.sentient/gateway/logs/$(date +%F).log | tail -10
```

Then do it a second time — the first restart of a session has started cleanly before; the hang showed
up on subsequent ones.

**Expect (log):** `native.started` for **both** `whisper-stt` **and** `local-tts`, followed by
`apply.complete`. All three lines, both times.

**Expect (observable):**

```bash
lsof -nP -iTCP:8768 -iTCP:8770 -sTCP:LISTEN
```
→ both ports listening on `127.0.0.1`.

**If it fails** — i.e. you get `native.started | service="whisper-stt"` and then silence, with no
`apply.complete`: you have reproduced it. Capture the log window and note the elapsed time (the agent
waited 140+ seconds with no progress and near-zero CPU, so it is a stuck `await`, not a busy loop).
This is an open P1 defect needing a code fix in the gateway's native driver, not an operator action —
restarting again is the only workaround. Please report it rather than working around it silently.

---

## 6. Acoustic barge-in — web

Speaking over the assistant while it is talking must stop it. This is the one gesture that produces
`cutoff="barge-in"`; there is **no button anywhere in the UI that produces it** (an earlier version of
the test plan claimed there was a "UI arm" — that was a planning error; the Stop button always
produces `cutoff="interrupt"`, which is a different, separately-verified gesture). A real
speech-onset through a real microphone is the only trigger.

**Why not an agent:** headless Chromium has no microphone. The fake-device flags inject an audio
*file*, which does not reproduce acoustic echo through a real speaker — and echo behaviour is
precisely the thing under test.

**Steps**

1. Open the web UI, enable voice, ask something with a long answer ("tell me a story about…").
2. While the assistant is **still speaking**, speak over it at normal volume.

**Expect (visible):** audio stops within roughly 200 ms. Any background task keeps running (barge-in
means "I'm talking", not "cancel my work").

**Expect (log):**

```bash
grep -E "stt.barge-in|playback.stop|cancellation" ~/.sentient/gateway/logs/$(date +%F).log | tail -8
```
→ `stt.barge-in`, then `session-runtime.playback.stop | cutoff="barge-in"` and
`turn-emitter.playback-stop | reason="barge-in"`.
There must be **no** `cancellation.background.cancel-all` line — that one belongs to interrupt only,
and its absence here is the assertion that background work survived.

**One expected difference depending on timing**, so you do not misread it as a bug: the assistant's
reply text finishes generating *before* its audio finishes playing. If you barge in while text is
still streaming you will see `cancellation.cutoff.committed` and the partial reply stays in the feed
marked as cut off. If you barge in during the audio tail — after the text already completed — you
will instead see `cancellation.no-turn-in-flight` and **no** cut-off marker, because there is no turn
left to cut off. Audio still stops in both cases. Both are correct.

**If it fails:** note *which* half failed. Audio kept playing → the client never flushed its queue
(client bug). The reply kept generating → the server abort was never reached (server bug). They are
different bugs and the log tells you which: `stt.barge-in` present means the trigger fired and the
problem is downstream; absent means the microphone onset never reached the gateway at all.

---

## 7. Acoustic barge-in — physical phone

**Why not an agent:** simulators and emulators have no real audio path. This is exactly what the
`physical-only` tag on the mobile test suite exists for.

**Steps:** the same as §6, on a real Android or iOS device on the same LAN as the gateway.

**Expect:** identical behaviour, and specifically that the client's audio queue **flushes and does not
resume** — a device that goes quiet and then starts talking again a second later has flushed the
wrong buffer.

**Log:** same greps as §6.

---

## 8. Echo-cancellation quality under real acoustics

**Why not an agent:** it is subjective, and depends entirely on your room, your microphone and your
speaker. There is no assertion to write.

**Steps:** hold a normal spoken conversation at a comfortable volume, in the room where the device
actually lives.

**Expect:** the assistant does not barge-in on *its own* TTS output. If it cuts itself off, echo is
leaking past the cancellation.

**If it fails:** `stt.barge-in` appearing while nobody spoke is the signature. The tunable is
`stt.tts_echo_cooldown_ms` in `~/.sentient/gateway/config.yaml` (default 2500, range 0–5000) — the
window during which the microphone is hard-muted after audio starts, so the browser's echo canceller
can converge. Raise it before suspecting anything deeper.

---

## 9. Full voice round-trip, by hand

Speak → transcribe → think → reply → speak. Every individual leg is verified, and the text path is
green end to end, but the **microphone leg has never been driven by a machine in this project** —
there is no automated case that starts from real speech.

**Why not an agent:** it needs a physically held microphone. Automating it would need a fixture
audio-capture channel put back into the mobile SDK's voice engine plus a matching arm in the debug
receiver — that code does not exist, which is why the `voice-roundtrip` case is marked undriven rather
than failing. Doing it by hand takes 30 seconds and proves the same thing.

**Steps:** hold the talk button on a real phone (or use the web UI's voice toggle), say something
short and specific, release, wait for the spoken reply.

**Expect (visible):** your words appear as the transcript, a reply streams, and the reply is spoken.

**Expect (log)** — this exact sequence, in this order:

```bash
grep -E "stt\.|turn-voice\.|mic-suppress" ~/.sentient/gateway/logs/$(date +%F).log | tail -20
```
→ `stt.connecting` → `stt.connected` → `stt.audio-start` → `stt.transcript.submit` →
`turn-voice.begin` → `turn-voice.audio.start` → `mic-suppress.tts-start` → `turn-voice.audio.done`.

**If it fails:** `stt.transcript.submit` missing but `stt.connected` present means audio reached the
service and produced nothing — a microphone gain or format problem, not a wiring problem.
`turn-voice.silent` instead of `turn-voice.audio.start` means the reply was produced but TTS was never
asked for — check that voice output is enabled for that user.

---

## §10–§12: these need your PIN

An agent cannot log into the web UI or the app. Creating a session needs an admin token, which needs a
PIN, which needs an existing session — circular, and PIN guessing was correctly never attempted. All
three of these are otherwise ordinary five-minute checks once you are logged in.

## 10. A follow-up turn's audio must queue behind the still-playing turn

When you ask for something that gets delegated to a background agent, and that agent finishes *after*
the assistant already gave you its answer, the gateway starts a second turn in a new bubble. The text
half of this is verified and passes. The audio half is not.

**Why not an agent** (the exact reason recorded at the time, not a paraphrase): the harness that drove
this case talks to the gateway over the raw WebSocket seam and **never negotiates `audio.output`**, so
the gateway had no reason to open a TTS downlink and there was no audio queue to observe at all. The
absence of audio frames there is a property of the harness, not of the product. Verifying it needs a
client that actually negotiates `audio.output` and can observe playback ordering across two turns —
a real browser with TTS enabled, or the mobile app. Both need an authenticated session.

The mobile app is the better surface here: its audio downlink is lazily armed on the first
`audio.start`, so ordering is directly observable.

**Steps:** with voice output on, ask for something that delegates ("ask the research agent to look
into X, and meanwhile tell me a long story about Y"). Let the story play. The delegated result should
arrive while the story is still being spoken.

**Expect (visible):** the follow-up appears as a **new bubble**, and its audio starts **only after**
the first turn's audio finishes. Overlapping speech is the failure.

**Expect (log):**

```bash
grep -E "turn-voice.audio.(start|done)|turn-started" ~/.sentient/gateway/logs/$(date +%F).log | tail -10
```
→ the second `turn-started` carries `trigger="background-completion"`, and its
`turn-voice.audio.start` timestamp is **after** the first turn's `turn-voice.audio.done`.

---

## 11. Stop must kill a background task that is genuinely still running

The Stop button cancels the turn *and* every background task for that session. Three of the four links
in that chain are pinned by tests, and the fourth — that a cancel actually kills the real subprocess —
was proven for real against a live process (`[during] hermes pids: ["79522"]` → `[after] hermes pids:
[]`). What fired the cancel in that proof was the code path directly, not a click.

**Why not an agent:** the trigger link needs a click on the real Stop button in a logged-in browser.
Whoever drives this inherits a chain with no unproven link in it — you are confirming the button is
wired to a mechanism already known to work.

**Steps:** ask for something that delegates to the background agent and gives you a long spoken reply.
While the background task is still running, press Stop.

**Expect (visible):** speech stops, generation stops, and the delegated task does not later deliver a
result.

**Expect (log):**

```bash
grep -E "cancellation|background" ~/.sentient/gateway/logs/$(date +%F).log | tail -10
```
→ `session-runtime.playback.stop | cutoff="interrupt"` **and**
`cancellation.background.cancel-all | cutoff="interrupt"` with a non-empty task id list. A
`count=0` here means Stop fired correctly but there was nothing running yet — retry with a slower
delegated task rather than filing a bug.

Optionally confirm the OS process is really gone:
```bash
pgrep -fl hermes
```
→ nothing.

---

## 12. The mobile interrupt button, actually asserted

The mobile `05-interrupt` test **passes on both platforms** (Android 27 s, iOS 41 s) — but it only
asserts "message sent, reply streamed, app still alive". It never taps interrupt, so the interrupt
arm itself is unasserted on mobile.

**Why not an agent:** the interrupt control is gated on TTS *audio* state, not on the assistant
thinking — so the button only exists once audio is actually playing, which needs voice output enabled
and the audio downlink armed. Automating that reliably is a test-harness change, not a tap.

Two dead explanations you may find in older notes — **do not re-quote either**: the "session id" bug
that used to block this is closed, and the claim that the phone "cannot reach local-tts" was simply
wrong (the gateway dials TTS over loopback and the phone only ever receives the audio stream over its
existing connection).

**Steps:** on a real device with voice output on, ask for a long spoken answer, and tap the interrupt
control while it is speaking.

**Expect (visible):** speech stops immediately, the partial reply stays on screen marked as cut off.

**Expect (log):** identical to §11's `cutoff="interrupt"` lines.

---

## 13. Optional, low priority — the non-admin settings gate

`42-settings-non-admin-gate` checks that a non-admin household member cannot see admin-only settings.
It has never been driven on either platform.

**Why not an agent:** it needs a second, non-admin user, created by a test that is itself blocked
because your household is already at its three-user cap. Deleting one of your real family members to
free a slot is not an agent's decision to make.

**Steps:** if you want this covered, free a household slot (or raise the cap), then re-run the mobile
settings-admin test batch. Otherwise skip it — it is a UI-visibility check, not a security boundary
(the server-side authorization is enforced independently and is covered).

---

# Not in this checklist — no operator action

Everything below is recorded so it is not mistaken for a gap in the verification above. **None of it
needs your hands.** It needs code, or an agent run, and it is listed here because this document is the
one place work that could not be verified is allowed to live.

## A. Deliberately unfinished — needs code that is out of scope for this project

- **Multi-conversation.** Session switching, chat history, rename/delete and the past-chat drawer all
  need a sessions REST surface (`GET/PATCH/DELETE /api/v1/sessions*`) that the 2.0 gateway does not
  serve at all. Consequences you will see and should NOT file as bugs: the history drawer is **empty
  by construction** whatever your chat history holds; **"+ new chat" does not start a new server-side
  conversation** (it clears the screen but the assistant keeps the previous context, so a fresh-looking
  chat can resume the earlier task); and the mobile tests `01-newchat`, `06-switch-session`,
  `07-rename-delete` and `10-outbox` are **deliberately red** as the standing acceptance tests for
  that future project. Reload and reconnect *within one conversation* are fully verified and green.
  A related switch signal (`conversation.activate`) is deliberately left unanswered — answering it
  today would **wipe your visible chat**, because both apps read the reply as "now refetch history"
  from a route that does not exist.
- **The Hermes-shaped settings — soul, personality, long-term memory — are EXPECTED-INERT on 2.0.**
  This is the single most likely thing in the product to be misfiled as a bug. They render, they save
  without error, and they persist — and they do **not** change how the assistant behaves. That is the
  owner's decision, not a defect: those screens were built when Hermes was the agent runtime, and the
  gateway owns the loop now, so nothing in the live path reads them. The UI stays; the functionality
  transitions to gateway-owned in a later spec. "As designed, for now" — not broken.
- **Signal messaging** was removed outright as dead weight. Nothing to verify, nothing to restore.
- **Per-user long-term memory, skills, and recursive sub-agents** are named in the 2.0 design and
  specified in their own later specs. Out of scope for this migration.
- **A separate permission surface for delegated tools.** Delegation works and the delegated agent now
  holds a real, mediated tool set. What is deferred is the security *design*: what a sub-agent
  inherits, whether that can be scoped per-delegation, what revocation means once a subprocess is
  already running, and above all what the single pre-delegation confirm dialog actually grants and how
  its scope is shown to you before you approve it. Note one decision that is already made: that
  confirm is a **one-time** dialog before the tool starts, and nothing inside the run re-prompts — by
  design, so a delegated tool can do long unsupervised work.
- **Two gateway tools have no caller at all** — the voice-identity rebind (`identify_user`) and the
  settings write (`update_user_settings`). They are reachable neither by the gateway's own loop nor by
  the delegated agent. Correct per the delegated-tool decision, wrong as a product state; it lands
  with the permission surface above, or sooner if voice identity switching is wanted back. Separately,
  the two audio tools the gateway hosts (`pause_audio`, `resume_audio`) are still fail-closed stubs
  pending a real audio-pause primitive.
- **External tools should be configured at install time, not repaired at every use.** Today the
  gateway registers and repairs the delegated agent's configuration at the moment of delegation. The
  intended shape is that the installer installs the external tool *together with* its configuration,
  the way it installs the Python services with their locked wheels, and the runtime check degrades to
  a warning on drift. Four steps, in landing order: installer installs Hermes at a pinned version;
  installer renders its configuration; the set of external tools becomes declarative YAML rather than
  a special case; and a settings flow to inspect/enable/re-scope them.

## B. Was an open defect — fixed while this checklist was being written

- **A restarted addon container stayed dead for the life of the gateway process.** The shared MCP
  client cached one connection per tool server and only discarded it when the *initial connect*
  failed — never when a later call failed on an already-open connection. Since the orchestrator
  recreates the music addon during every boot, that server's tools went silently missing until the
  gateway was restarted, for the gateway's own loop as well as for delegated agents. **Fixed in
  `0d60359`** ("evict a dead MCP transport instead of caching it forever"). Nothing to verify — it is
  recorded here only so that an older note describing it as open does not send you looking.

## C. Drivable by an agent, simply not yet driven

- **The iOS soul/personality settings test batch has never been run on a simulator.** The Android
  equivalent was run, all four of its failures were root-caused, and the fixes are shared-shape — but
  the iOS wait-budget edits are syntax-verified only. This needs an agent with a simulator, not you.

## D. Small code and documentation debt found in passing

Recorded here only because it was found during the migration and would otherwise be lost. None of it
affects behaviour; all of it should migrate into `docs/native-todo.md`.

- `deploy/mac-prod/README.md:50-51` still documents the `/data/supervisor` named docker volume, which
  no longer exists.
- `gateway/src/tools/hermes-runner.ts:3` cites `admin/supervisord-control.ts`, a file deleted in this
  migration.
- `gateway/src/system-orchestrator/orchestrator.ts:161` logs `counts=[object Object]` — needs a spread
  so the boot summary is readable.
- `gateway/src/system-orchestrator/types.ts:40` hardcodes the network topology in TypeScript; per the
  project's own every-tunable-in-YAML rule it belongs in config.
- `shared/mobile-sdk/.../settings/AdminModels.kt:19` keeps a vestigial `port` field describing a
  per-user worker slot that no longer exists.

## E. Things that look like bugs in the logs and are not

- **Speech-to-text retries its connection once per microphone frame with no backoff** — 33 attempts in
  751 ms when the service is down. That is deliberate, documented design, and it looks alarming in a
  log.
- **On a development machine the gateway does not supervise the native services at all** (the
  environment variable that points at installed code is unset there). So a dev run is not evidence
  about supervision behaviour either way — which is exactly why §5 has to happen on the mini.

---

## Provenance

Every deferral raised anywhere in this migration — in the task plans, in the agent reports, in the run
ledger, and in `docs/native-todo.md` — was collected and cross-checked against this document:
**30 found, 30 written, each appearing exactly once.** Sixteen are action items, carried by the
fourteen numbered sections §0–§13; sixteen are the no-action records above. Two deferrals share a
section with another rather than getting their own, because the same single action verifies both:
the database schema-ahead branch sits inside §3 (a rollback is the only thing that executes it), and
the automated voice fixture channel sits inside §9 (which is the same round-trip, driven by hand).

Items confirmed **closed** by later work and therefore deliberately absent: the missing session
identifier that blocked every mobile chat, the Android permission dialog's missing test identifiers,
the duplicate-message defect, the delegated agent having no tools, the per-user tool socket living on
a read-only path, and a stale personality entry. If you find an older note asking you to verify any of
those, it is out of date.

Standing index of everything deferred, including the items above: `docs/native-todo.md`.
