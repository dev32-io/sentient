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

`gateway/src/external-tools/` holds the generic **external tool** contract — an external tool is one the gateway does not supervise (no lifecycle, port or health check), Hermes being the first of them. Registration is `hermes -p <id> mcp add gateway --command nc --args -U <resolveMcpSocketPath(id)>` through hermes's public CLI, read back afterwards because exit 0 is not evidence. The `hermes-profile.bridge.not-live` detector is deleted.

*Superseded by task 9g in one respect, kept here because the reasoning is what made the fix findable:* this originally ran as the last STARTUP step, gated on the system orchestrator's boot-reconcile completion. It now runs in `delegateTask`'s setup phase, at the moment of use, and the boot-time runner (and its `userLifecycle.onCreated` sibling) are deleted — see the follow-up section below.

Live-verified on `u_1eee01a4`, never hand-patched: `hermes.register.start` → `hermes.register.ok`, and its delegated agent now lists `mcp__gateway__pause_audio` and `mcp__gateway__resume_audio` and does **not** list `mcp__gateway__identify_user` or `mcp__gateway__update_user_settings`. Full close: `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` § "D11 — the close".

**Two decisions from the original write-up did not survive contact and are corrected here:**

1. *"The filter is one `.filter()` over the same list, so it costs nothing now"* — **wrong**, and it constrains what could ship. `hermes mcp add` grants a server's WHOLE advertised surface: the CLI has no non-interactive per-tool filter (selection is a curses checklist), and `hermes config set` cannot write a list — it coerces only bool/int/float, so `config set mcp_servers.gateway.tools.include '["a","b"]'` stores the string. The catalog's `tools.include` is a gateway-side filter that never reaches hermes. Registering `home_assistant` would therefore grant ha-mcp's ~84 upstream tools and `searxng` its 5 (one tiered). Both exceed the `allow` tier, so neither is registered; only the gateway's own MCP, whose surface the gateway controls, is.
2. Consequently *"reads, searches, HA state, MA browse"* is **not** what the delegated agent got. It got the gateway's allow-tier tools only. Delegation still works — it dispatches, runs a real credentialed hermes and returns a completion — it simply has no HA/MA/web MCP.

**What that left open — the first item is now CLOSED (task 9g); the second is not.**

- ~~**Per-server tool scoping for a delegated agent.**~~ **CLOSED 2026-07-30 (task 9g) — the gateway proxies instead.** The hermes-CLI limitation stands (no non-interactive include list), so the route taken was the other one: the gateway's per-user MCP socket now advertises the `allow` tier of `mcp_catalog` as **proxied** tools, each dispatched through a per-user `ToolBroker` so the gateway's own PDP evaluates every call. Registering `home_assistant` on a hermes profile would have granted ha-mcp's ~84 upstream tools; proxying grants exactly the tier. Live on `u_1eee01a4`, the delegated agent holds `mcp__gateway__search_web`, `mcp__gateway__fetch` and ten `mcp__gateway__ha_*` reads, and none of `ha_call_service` / `ha_bulk_control` / the todo+calendar writes / `ma_queue*` / `identify_user` / `update_user_settings` / `delegateTask`. Evidence: `qa/web/evidence/2026-07-30-t9g-delegate-proxy-tier/README.md`.
  - Registration also moved from **boot** to **dispatch** (owner's call): `delegateTask` verifies and repairs the entry's CONTENT immediately before spawning, so a user editing their own profile can no longer leave every delegation tool-less until the next restart. It is non-fatal (a failure WARNs and dispatches anyway) and bounded by `hermes_mcp_register_timeout_ms` across the whole phase.
  - It is **additive by construction**: the gateway reads the map, compares its one `gateway` key, and writes only that. It never prunes, reorders or normalises a user's own MCP servers. Proven live and pinned by test.
- **The real answer, still deferred:** a delegated tool is *intended* to be dangerously capable, and the `allow` tier is a blunt instrument. What this wants is a **separate permission surface for delegated tools**, tuned independently of the tool settings that govern Sentient's own orchestrator layer — what a sub-agent inherits and whether that can be scoped per-delegation, what revocation means once a subprocess is running, and above all **what the one pre-delegation confirm dialog actually grants and how its scope is shown to the user before they approve it**. Note what this is *not*: mid-run permission routing is ruled out by design (owner, 2026-07-30) — the confirm gate for a delegation is a ONE-TIME dialog before the tool starts, and nothing inside the run re-prompts, so that the delegated tool can be genuinely capable on long unsupervised work. Its own spec. **It does not block current work.**

### ~~The shared `McpClient` never recovers a catalog server that restarted under it~~ — CLOSED 2026-07-30 (plan task 9h)

Found while verifying 9g. `tools/mcp-client.ts` cached one transport per catalog server and evicted it only when the CONNECT itself rejected — never when `listTools`/`callTool` failed. So when the system orchestrator recreated an addon container *after* the gateway had connected (which it does for `ma-mcp` on every dev boot: the boot warm-up connects, then `apply` recreates), every later call to that server returned `-32600 Session not found` for the lifetime of the process, and only a gateway restart cleared it. Both consumers were hit: the gateway's own ReAct loop silently lost that server's tools, and so did the delegated proxy tier.

A cached transport is now evicted the moment a request proves it dead, and the two paths recover differently **on purpose**:

- `listTools` redials **once inside the call** — it is read-only and idempotent, so re-running it cannot double a side effect. The tool *surface* recovers with no user-visible failure. The redial shares one whole-phase `timeout` budget with the first attempt (a recovering server can never double a user-visible wait), and is skipped when the failure was a failed *connect*, since dialling a down server twice in one phase buys nothing.
- `callTool` evicts but is **never transparently re-invoked**. A tool may be side-effecting (`ha_call_service`, `ma_play_media`, a calendar write) and the transport layer cannot know whether a request that failed mid-flight already executed. The retry decision belongs to the ReAct loop, where the PDP re-mediates it.

The eviction boundary itself is the judgement: a transport counts as alive only when the session is *proven* usable — the caller aborted (`signal.aborted`, checked first because the SDK's `throwIfAborted` yields a bare `DOMException`, so barge-in must never evict), or the peer answered with a JSON-RPC error (`McpError` with any code but `ConnectionClosed`: bad args, unknown tool, tool failure, request timeout). A tool that legitimately answers "no such playlist" is a *working* transport. Everything else — HTTP-level rejection of the POST, socket error, transport close — leaves usability unproven and is dropped.

Live proof, both consumers, `ma-mcp` restarted under a running gateway each time:
- Delegated agent (`hermes -p u_1eee01a4`): `mcp.transport.evicted` → `mcp.list-tools.redial` → `mcp.connect.ok` → `mcp.list-tools.ok totalCount=10` in **42 ms**, and the listing carries `ma_search / ma_browse / ma_list_players / ma_playback / ma_play_media / ma_volume` again.
- Gateway's own ReAct loop (real `SessionRuntime`, real provider): a turn whose broker warm-up was already memoized went `ma_list_players:running → error → running → done` and answered correctly, i.e. it recovered *within the turn*. At the client level the same restart yields `CALL 1 isError=true … (connection was reset; a retry will redial the server)` then `CALL 2 isError=false` with the real player list.

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

### `identify_user` and `update_user_settings` now have no caller at all

Found while closing D11, and it predates that fix. Both tools are registered ONLY on the gateway's per-user MCP host (`bootstrap/create-mcp-host.ts`), which serves only the delegated agent — the gateway's own ReAct loop reaches tools through `tools/mcp-client.ts`, and that client dials **http transport only** and skips the stdio `mcp_catalog.gateway` entry outright (`mcp.entry.stdio-skipped`). So the gateway's own loop never had them.

Task 9d's tier filter then withholds both from the delegated agent as well (`identify_user` is confirm/deny-tier, `update_user_settings` is confirm-tier). Net effect: the voice identity rebind and the settings write are unreachable on 2.0. That is correct per the delegated-tool decision but wrong as a product state.

The fix is not to widen the delegated tier — it is to give the gateway's OWN loop a path to its own tools, which is what §2's "Hermes-shaped settings are expected-inert on 2.0" is already about. Land it with the delegate-tool permission surface above, or sooner if voice identity switching is wanted back.

Note also that `pause_audio` / `resume_audio` — the two tools the gateway HOSTS for a delegated agent — are still stubs: `createUnavailableSessionLookup` means they fail closed with "no active session" until Plan 2 wires a real resolver together with a real audio pause primitive. Since task 9g the delegated agent also holds the PROXIED tier (HA reads, `fetch`, `search_web`), which is not stubbed and returns real upstream data — so a delegated run is now genuinely useful even though the two hosted tools are not.

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
3. **A generic external-tool registry** — the `ExternalTool` contract is already generic (one interface, one `provide(userId)`); make the SET of external tools declarative (config, like `mcp_catalog`) rather than a Hermes special case, so adding a second delegated agent is a YAML edit plus one implementation. Note that since task 9g the caller is `delegateTask`, not a boot step, so the registry is keyed by delegated agent name rather than iterated at startup.
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
