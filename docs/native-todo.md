# Native migration — deferred work log

Everything the native-stack migration (`docs/superpowers/specs/2026-07-29-native-stack-migration-design.md`) knowingly left undone, in one place so it stops living in agent reports that nobody re-reads.

Three kinds of entry, kept separate on purpose — the difference matters when deciding what blocks a merge:

- **Open defects** — the product is wrong. Someone has to fix it.
- **Deferred by scope** — the product is right for 2.0; the work is a later project.
- **Operator handoff** — verified nowhere because an agent physically cannot; needs your hands or a second machine.

Status as of 2026-07-30, branch `feature/native-orchestrator`.

---

## 1. Open defects

### ~~D11 — the delegated Hermes has no tools~~ — CLOSED 2026-07-30 (plan task 9d)

`gateway/src/external-tools/` is a generic **external-tool configuration handler** — an external tool is one the gateway does not supervise (no lifecycle, port or health check), Hermes being the first of them. It runs as the last startup step, after `mcpHost.start()` and gated on the system orchestrator's boot-reconcile **completion**; a null signal skips loudly (`external-tools.skipped`) instead of registering against sockets nothing serves. Registration is `hermes -p <id> mcp add gateway --command nc --args -U <resolveMcpSocketPath(id)>` through hermes's public CLI, read back afterwards because exit 0 is not evidence. The `hermes-profile.bridge.not-live` detector is deleted.

Live-verified on `u_1eee01a4`, never hand-patched: `hermes.register.start` → `hermes.register.ok`, and its delegated agent now lists `mcp__gateway__pause_audio` and `mcp__gateway__resume_audio` and does **not** list `mcp__gateway__identify_user` or `mcp__gateway__update_user_settings`. Full close: `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` § "D11 — the close".

**Two decisions from the original write-up did not survive contact and are corrected here:**

1. *"The filter is one `.filter()` over the same list, so it costs nothing now"* — **wrong**, and it constrains what could ship. `hermes mcp add` grants a server's WHOLE advertised surface: the CLI has no non-interactive per-tool filter (selection is a curses checklist), and `hermes config set` cannot write a list — it coerces only bool/int/float, so `config set mcp_servers.gateway.tools.include '["a","b"]'` stores the string. The catalog's `tools.include` is a gateway-side filter that never reaches hermes. Registering `home_assistant` would therefore grant ha-mcp's ~84 upstream tools and `searxng` its 5 (one tiered). Both exceed the `allow` tier, so neither is registered; only the gateway's own MCP, whose surface the gateway controls, is.
2. Consequently *"reads, searches, HA state, MA browse"* is **not** what the delegated agent got. It got the gateway's allow-tier tools only. Delegation still works — it dispatches, runs a real credentialed hermes and returns a completion — it simply has no HA/MA/web MCP.

**What that leaves open, in the order it would sensibly land:**
- **Per-server tool scoping for a delegated agent.** Needs either a hermes CLI that can set an include list non-interactively (upstream ask), or the gateway proxying those MCPs so its own PDP sees the call — the proxy the owner ruled over-complicated when the filter looked free. It no longer is free, so the trade-off is worth re-deciding before granting HA/MA/web to a sub-agent.
- **The real answer, still deferred:** a delegated tool is *intended* to be dangerously capable, and the `allow` tier is a blunt instrument. What this wants is a **separate permission surface for delegated tools**, tuned independently of the tool settings that govern Sentient's own orchestrator layer — what a sub-agent inherits, whether it can be scoped per-delegation, whether a confirm prompt reaches the delegator mid-delegation, what revocation means once a subprocess is running. Its own spec. **It does not block current work.**

### ~~D12 — the gateway never answers `session.new`~~ — CLOSED 2026-07-30 (plan task 9e)

`gateway/src/session-handlers/ws-session-new.ts` answers it with `session.created` carrying this connection's durable conversation id. Device-verified on both platforms with every flow unedited: Android `chat` 0/6 → 5/6, iOS 0/5 → 4/5, `data.send-message: flush count=1 sessionId=c::…` replacing `flush-skipped reason=no-id-attached`. Evidence: `qa/mobile/evidence/2026-07-30-t9e-session-new/`.

**Only the `session.new` half closed.** `conversation.activate` remains deliberately unanswered — see §2, where the reason is now precise rather than "later scope".

D12 was masking three further defects, filed below as D13/D14/D15. Do not read a green `chat` batch as a clean path.

### ~~D13 — the Android permission dialog exports no test ids~~ — CLOSED 2026-07-30 (plan task 9f)

`PermissionPromptDialog.kt`'s `AlertDialog` now carries its own `Modifier.semantics { testTagsAsResourceId = true }` — a Compose dialog composes into its **own window**, a separate semantics owner, so the flag set once on `AppNavHost.kt`'s `Surface` never reached it and `uiautomator dump` showed every node with `resource-id=""`. `android/12-permission-confirm` is green **unedited** (24 s), full arm driven: prompt → `chat-permission-allow` tap → dialog gone → assistant reply.

**Durable rule, now in `agents/docs/testing-knowledge.md`:** any Compose surface in its own window — `AlertDialog`, `DropdownMenu`, `ModalBottomSheet`, `Popup` — needs its own copy of that modifier.

### ~~D14 — every mobile message is committed 2–6 times~~ — CLOSED 2026-07-30 (plan task 9f)

The round trip is restored on the store substrate, all three halves — persist, echo, dedupe:

- `entries.pending_id`, added by a **`user_version` migration ladder** over a now-FROZEN baseline DDL (`gateway/src/store/schema.ts`, `migrate-store.ts`). `CREATE TABLE IF NOT EXISTS` is not a migration: every per-user database under `~/.sentient` already existed at `user_version=0` with no such column. Freezing the baseline means a fresh database and a long-lived one run the **same** migration code, so a fresh-DB test can no longer pass while a real user's fails.
- The echo rides `projectForClient`, the single path both `conversation.entry` and `conversation.snapshot` use, so `render(replay) == render(live)` holds for `pendingId` structurally — a reconnect cannot resurrect a duplicate the client already settled.
- Dedupe lives in `SessionRuntime.submit` (where the store append happens), **not** in the router, and a duplicate is **re-echoed** via `feed.republish` rather than dropped: committed once, answered every time. A silent drop would leave the client's outbox retrying forever.

Device-verified on `emulator-5554` against the live store, counting rows rather than eyeballing the screen. Pre-fix, on the same flow and the same message: 2 rows, one turn, no `pending_id`. Post-fix: **0 duplicate `(session_id, pending_id)` groups** across 10 sends; every same-text pair carries a *distinct* `pending_id`, i.e. they are genuinely separate sends. The worst pre-fix group in the polluted store was **30×** one message, not the 2–6× first reported.

Historical description, kept because the diagnosis is what made the fix findable — the KMP outbox's contract is *"the gateway dedups by pendingId"* — stated three times in `OutboundCache.kt`. It does not. `pendingId` is in the wire schema (`shared/protocol/src/messages.ts:150`), `grep -rn pendingId gateway/src` returns zero non-test hits, and the `entries` table has no `pending_id` column, so the committed echo cannot carry one even in principle. The entry therefore never reconciles, `ChatViewModel` re-runs `flushIfReady` on every `connection.state` emission, and the same message is re-sent — then swept to `FAILED`, showing a **Retry chip under a message that was delivered**. Measured 2× on a plain turn and 6× across a long one.

A regression of the 2.0 legacy purge, not of task 9e: `git log -S pendingId -- gateway/src` shows `6c7bc1c` (dedup) and `aef5e0c` (echo on the feed) both removed by `10bd446`. D12 hid it — nothing was ever sent.

**Do not fix this with a dedupe guard in the router.** That is the D7 mistake from NM-T9c: the projection was the bug and a guard would have masked it. Restore the round trip — persist `pendingId` on the user entry, echo it on `conversation.entry` — which crosses the store schema and both projections.

### D15 — "+ new chat" does not reset the server-side conversation

A surface has exactly one durable conversation on 2.0, so `session.new` is answered with the existing id: "+" clears the client's mirror but leaves the server thread and its context. Observed consequence, not theoretical — `ios/01-newchat.yaml` sends `what is 8 plus 9` into a fresh-looking chat and the model calls `ha_call_service`, resuming the *previous* conversation's task, so the turn parks on a permission prompt and no reply ever renders.

The alternative was rejected on evidence: minting a fresh partition per `session.new` would fork on **every app launch** (the chat route's default `sessionId` is null, so `ChatViewModel.init` fires `sendNewChat()` with no user tap — and the VM initialises twice per launch), destroying `reload-convergence` and `restart-persistence`. Closing this properly is the multi-conversation project in §2. `01-newchat` is left red as its standing acceptance test.

**Blast radius is wider than `01-newchat` — measured 2026-07-30 (task 9f), first drive of the `session` tag on 2.0.** With D14 closed the QA store was reset to a clean partition, which exposed that three more Android flows cannot be satisfied on 2.0 at all. None is a regression; all three are the same missing surface:

- `06-switch-session` and `07-rename-delete` need at least one `history-row-<sessionId>`. The drawer's list, rename, delete and search are `GET/PATCH/DELETE /api/v1/sessions*` (`shared/mobile-sdk/.../SessionsHttpClient.kt`), and **the 2.0 gateway serves no `/api/v1/sessions` route at all** — `grep -rn "api/v1/sessions" gateway/src` is empty and `ws-handlers.ts:212` says so in prose. The drawer is therefore empty by construction, whatever the store holds. Both flows FAIL with `Element not found: Id matching regex: .*history-row-.*`.
- `10-outbox` asserts `message-bubble-0`, and that tag is the **list index** (`MessageBubble.kt:68`), so index 0 is the oldest message in the conversation. Written when a fresh chat started empty; on 2.0 one durable conversation never resets, so index 0 is permanently off-screen and the flow can only pass on a fresh install. It needs re-grounding onto the newest bubble, which is the multi-conversation project's call, not a budget change.

These three go with the multi-conversation project in §2, not to Task 11.

### ~~Stale personality entry becomes live once D11 lands~~ — CLOSED 2026-07-30 (plan task 9d)

Both writers now reject an empty personality body (`invalid-body` → 422) and `preserveAgentSections` drops the entries older builds wrote, so an existing install converges on the next boot re-render. Verified live: `preserve.dropped-personalities | dropped=1`, and the affected user's rendered config.yaml no longer carries a `personalities` key.

Framing correction: it is **not** left behind by a delete. `personality-store.remove` was reproduced against a temp profile and removes the key cleanly. The live artifact was an empty-bodied personality that was *written* that way, which the add/update path accepted.

---

## 2. Deferred by scope

- **Multi-conversation** — session switching and past-chat history need the sessions REST surface (`GET /sessions/:id/messages`) plus the `sessions.*` frames wired end to end. Its own project. Reload and reconnect *within one conversation* are verified and green. Three things are parked here, not merely "later":
  - **`conversation.activate` is answered by nobody, deliberately.** Its only reply is `session.switched`, which both SDKs read as "refetch history over `GET /sessions/:id/messages`"; that route is unserved and mobile's failure branch is `SdkConnectors.loadHistoryForSession` → `replaceMirror(emptyList())`. Answering would **wipe the visible chat** — and not only on a user's switch: `SentientSdk.reestablishAnchoredSession` fires an activate on every reconnect that carries an anchor without a resume cursor, a path that task 9e's `session.new` answer newly arms. The gateway re-anchors from `session.configure.conversationId` on that same reconnect anyway, so leaving it unhandled costs nothing. It becomes answerable when the history route lands, not before. Reason recorded in `ws-handlers.ts`'s `default:` arm and pinned by a test.
  - **"+ new chat" does not reset the server-side thread** — D15 in §1.
  - **`session.new` returns the surface's existing conversation id**, deliberately, because mobile fires it on every launch. See `gateway/src/session-handlers/ws-session-new.ts`.
- **Hermes-shaped settings are expected-inert on 2.0** — soul, personality and long-term memory were built against Hermes as the agent runtime. The gateway owns the loop now, so those screens render and persist but do not change behaviour. Keep the UI; the functionality transitions to gateway-owned in a later spec. An operator testing personality and finding it does nothing must be able to tell "as designed, for now" from "broken" — this is the single most likely thing to be misfiled as a bug.
- **Signal** — removed outright as dead weight. Nothing to verify, nothing to restore.
- **Per-user long-term memory, skills, recursive sub-agents** — named in the 2.0 design, specified in their own later specs. Out of scope for the walking skeleton.

---

## 3. External-tool installation and configuration

Today the "configure external tool" handler runs at **gateway startup** and reconciles Hermes into a working state. That is the interim shape, chosen because it works without an installer change and self-heals a box whose config drifted.

**Where this is going:** installation-time configuration. The installer should install Hermes — and any future delegated tool — *together with its configuration*, the same way it installs the Python addons with their locked wheels. A delegated tool is a dependency of the product, not something the product repairs at every boot.

Deferred items, in the order they'd sensibly land:

1. **Installer installs Hermes** — pinned version, verified, alongside the gateway's own install. Today it is assumed present on `PATH`.
2. **Installer renders the tool's configuration** — profile registration and MCP wiring done once, at install, rather than reconciled per boot. The startup handler then degrades to a *check* that WARNs on drift instead of a *repair* that performs it.
3. **A generic external-tool registry** — the startup handler is already written generically; make the set of external tools declarative (config, like `mcp_catalog`) rather than a Hermes special case, so adding a second delegated agent is a YAML edit.
4. **Settings + tweak flow** — how an operator inspects, enables, disables and re-scopes an external tool from the UI. Depends on the delegate-tool permission surface in §1/D11. Design later.

---

## 4. Operator handoff — needs your hands or a second machine

Full checklist with exact steps and expected log lines: `docs/superpowers/handoffs/2026-07-29-native-migration-operator-checklist.md` (written by plan task 11). Index only, here.

**Do this one first — it is a live exposure, not a verification:**

- **A `whisper-stt` install predating the bind fix still has `host: 0.0.0.0`.** The shipped example was fixed; an existing install keeps its old live value, so the mini exposes STT on the LAN until edited. `~/.sentient/whisper-stt/config/config.yaml` → `host: 127.0.0.1` → restart the addon.

**Needs real hardware or a second machine:**

- Acoustic barge-in, web — headless Chromium has no mic; a fake device injects a file, which does not reproduce acoustic echo through a real speaker, and echo behaviour is the thing under test.
- Acoustic barge-in, physical phone — simulators have no audio path. This is what the `physical-only` Maestro tag is for.
- Echo-cancellation quality under real acoustics — subjective; depends on room, mic and speaker.
- Off-box LAN negative probe — the agent probed the LAN IP *from the mini*, which proves the bind. Proving unreachability from elsewhere needs a second machine.
- `code-immutability` — writing into `/opt/sentient/<version>/` as the service user must fail. Needs interactive `sudo`.
- `offline-install` — install with networking off, proving the vendored wheels really are sufficient. Needs a real network-off toggle.
- `upgrade-rollback`, root half — the health-gate and rollback logic are verified; the privileged symlink flip is not.

**Needs a credential the agent does not hold (a user PIN):**

- `steer-followup-audio`, audio half — the text half is verified. The WS-seam harness negotiates no `audio.output`, so the audio half needs a real browser session.
- `interrupt`, browser-Stop trigger — the abort path is verified server-side; driving the actual UI control needs a logged-in browser.

**Native rows left undriven, or driven but only partly asserted — with the reason:**

- `voice-roundtrip` — undriven. Needs a fixture capture source back in the SDK voice engine plus a `kind=fixture` arm in `DebugFaultReceiver`, and a physically held mic.
- `05-interrupt` — **driven and green on both platforms** (task 9e: Android 27s, iOS 41s), but it asserts send → stream → app-alive only; the interrupt **arm** is still unasserted. Live blocker: `chat-interrupt` is gated on TTS audio state, not cognition, so the session needs `speak=true` plus an armed audio downlink before the button exists to tap. Two dead reasons — do not re-quote either: D12 is **closed**, and the old "no reachable local-tts on the device" premise was **wrong** (the gateway dials local-tts over loopback).
- **iOS `settings-soul` batch was never run.** The Android run root-caused all four failures and the fixes are shared-shape, but the iOS `45*/47/48/49` wait-budget edits are syntax- and shape-verified only, never driven on a simulator.
- `42-settings-non-admin-gate` — undriven on both platforms. It needs the temp user that `41-members-add-cap` creates, and `41` is blocked by the 3-user household cap.

---

## 5. Observations recorded, deliberately not filed as defects

- **STT dial retries once per mic frame with no backoff** — 33 attempts in 751 ms when the STT service is down. Documented, deliberate design in `stt-session.ts:10-19`. Recorded because it *looks* like a defect in a log and someone will eventually file it.
- **`SENTIENT_CODE` is unset in dev**, so the dev gateway's orchestrator cannot supervise the native addons. STT/TTS were healthy and dialled directly either way. Consequence: the gateway process driving a dev E2E run is **not** the addon supervisor — do not read supervision behaviour off a dev run.
- **The emulator reaches the gateway via `10.0.2.2` and the simulator via the shared host network**, so the `0.0.0.0` bind has never been exercised by a real LAN device. That is what the off-box probe in §4 is for.
