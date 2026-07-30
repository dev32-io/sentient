# Native migration — deferred work log

Everything the native-stack migration (`docs/superpowers/specs/2026-07-29-native-stack-migration-design.md`) knowingly left undone, in one place so it stops living in agent reports that nobody re-reads.

Three kinds of entry, kept separate on purpose — the difference matters when deciding what blocks a merge:

- **Open defects** — the product is wrong. Someone has to fix it.
- **Deferred by scope** — the product is right for 2.0; the work is a later project.
- **Operator handoff** — verified nowhere because an agent physically cannot; needs your hands or a second machine.

Status as of 2026-07-30, branch `feature/native-orchestrator`.

---

## 1. Open defects

### D11 — the delegated Hermes has no tools (decided, ready to build)

The gateway renders `mcp_servers` + `enabled_toolsets` into `~/.sentient/gateway/<id>/profiles/<id>/`; Hermes reads `~/.hermes/profiles/<id>/`. The bridge between them was `HERMES_HOME` in the supervisord program env — **deleted by our own native cutover**. The render has been dead output ever since, so every delegated agent on every fresh install has zero gateway/HA/MA/searxng tools.

Contained, not silent: `hermes-profile.bridge.not-live` WARNs once per user per boot with `reason`, `renderedRoot`, `defect="D11"`. Deleting that guard is the exit criterion of the fix, not its start.

**Decisions taken (2026-07-30):**
- Hermes dials the MCP servers **directly**. No gateway proxy — the proxy is over-complicated for the value today, and only starts earning its complexity if the delegated agent ever needs write tools.
- Registration happens at **gateway startup**, through a **generic "configure external tool" handler**, sequenced *after* the system-orchestrator finishes bringing up internal dependencies (docker addons, native addons, MCP servers). Generic because Hermes is the first external tool, not the only one.
- Registered surface is the **`allow` tier of `gateway/mcp-policy.yaml` only** — reads, searches, HA state, MA browse. `confirm` and `deny` tier tools stay gateway-only.

**Why the tier filter, and what it costs:** because Hermes dials those servers itself, the gateway's PDP/PEP never sees the call — no `confirm` prompt, no argument-value check. `delegateTask` exists to go read the web (searxng, fetch), which is a prompt-injection surface; an injected page telling the delegated agent to turn off the alarm would otherwise execute unmediated. The filter is one `.filter()` over the same list, so it costs nothing now.

**The real answer, deferred:** a delegated tool is *intended* to be dangerously capable, and the `allow` tier is a blunt instrument for that. What this actually wants is a **separate permission surface for delegated tools** — its own settings page, tuned independently of the tool settings that govern Sentient's own orchestrator layer. That is a genuine security design (what does a sub-agent inherit, can it be scoped per-delegation, does a confirm prompt reach the delegator mid-delegation, what does revocation mean once a subprocess is running), and it deserves its own spec. **It does not block current work.**

Task body: `docs/superpowers/plans/2026-07-29-native-stack-migration/task-9d-hermes-profile-bridge.md`.
Full diagnosis: `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` § D11.

### D12 — the gateway never answers `session.new`

`gateway/src/session-handlers/ws-handlers.ts:189` routes `session.new` and `conversation.activate` to the `default:` arm with "not yet wired". **Every mobile text send is blocked on both platforms** — the client waits for a reply that never comes. Seven Android rows in the native matrix are red on this one cause, plus `12-permission-confirm` on both platforms.

Both response frames already exist in the frozen protocol: `session.created` and `session.switched` at `shared/protocol/src/sessions.ts:40,57`. The fix is to answer, not to design.

Note the split: answering `session.new` unblocks **creating** a conversation. Switching to a **past** conversation additionally needs the history-load REST route — `GET /sessions/:id/messages`, which `ws-session-configure.ts:385` records as deliberately unserved. See §2.

### Stale personality entry becomes live once D11 lands

After deleting a personality, the rendered `config.yaml` keeps a `personalities: {<name>: ""}` entry. Harmless **today** only because D11 makes that file dead output. The moment the profile bridge works, it stops being harmless. Fix it with D11, not after.

---

## 2. Deferred by scope

- **Multi-conversation** — session switching and past-chat history need the sessions REST surface (`GET /sessions/:id/messages`) plus the `sessions.*` frames wired end to end. Its own project. Reload and reconnect *within one conversation* are verified and green.
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

**Native rows left undriven, with the reason:**

- `voice-roundtrip` — needs a fixture capture source back in the SDK voice engine plus a `kind=fixture` arm in `DebugFaultReceiver`, and a physically held mic.
- `05-interrupt` — blocked behind D12, then needs the TTS audio-state gate. (Its old "no reachable local-tts on the device" premise was **wrong** — the gateway dials local-tts over loopback.)
- **iOS `settings-soul` batch was never run.** The Android run root-caused all four failures and the fixes are shared-shape, but the iOS `45*/47/48/49` wait-budget edits are syntax- and shape-verified only, never driven on a simulator.
- `42-settings-non-admin-gate` — undriven on both platforms. It needs the temp user that `41-members-add-cap` creates, and `41` is blocked by the 3-user household cap.

---

## 5. Observations recorded, deliberately not filed as defects

- **STT dial retries once per mic frame with no backoff** — 33 attempts in 751 ms when the STT service is down. Documented, deliberate design in `stt-session.ts:10-19`. Recorded because it *looks* like a defect in a log and someone will eventually file it.
- **`SENTIENT_CODE` is unset in dev**, so the dev gateway's orchestrator cannot supervise the native addons. STT/TTS were healthy and dialled directly either way. Consequence: the gateway process driving a dev E2E run is **not** the addon supervisor — do not read supervision behaviour off a dev run.
- **The emulator reaches the gateway via `10.0.2.2` and the simulator via the shared host network**, so the `0.0.0.0` bind has never been exercised by a real LAN device. That is what the off-box probe in §4 is for.
