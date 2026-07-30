# Native Stack Migration — Design

- **Date:** 2026-07-29
- **Branch:** `feature/native-orchestrator` (continues Sentient 2.0)
- **Status:** Design approved; pending spec review → implementation plan
- **Predecessor:** `2026-07-23-sentient-2.0-native-orchestrator-design.md` (slices 0–9)

---

## 1. Thesis

Sentient 2.0 makes the gateway a native LLM orchestrator. This spec makes it a **native process**.

The gateway is already a host-level orchestrator in code — `system-orchestrator/` owns a dependency graph, a dockerode driver, health checks and a boot reconciler, and it supervises eight services today. The only incoherence is that the gateway is *itself* a container, managing sibling containers through a mounted socket. That single fact:

- **breaks `delegateTask`.** `hermes-runner` does `Bun.spawn(["hermes", …])`, which resolves against the gateway process's own filesystem. The host `hermes` bottoms out at a Mach-O arm64 `python3`; the gateway image is Linux. No mount or `PATH` edit bridges that — it is an OS/ABI boundary. `delegateTask` therefore cannot work in **any** containerised deployment as currently built, including production.
- **blocks the 2.0 E2E matrix**, which needs delegation to be real.

The fix is to lift the gateway out of Docker into the host-manager role it already plays in code, and to formalise the model it implies: **Sentient core runs native; capabilities run as addons the gateway spawns.**

### 1.1 The addon model

Addons are plugins the gateway starts, supervises and health-checks. Their packaging is an implementation detail *of the addon*, not of Sentient:

- **Docker addons** — third-party or network-isolated software: the MCP servers, searxng, egress-proxy.
- **Native addons** — host processes: whisper-stt, local-tts.

> **Addendum 2026-07-29 (operator directive):** `signal-cli` was removed from the repo entirely
> (Task 6b) as dead weight — it was never registered in `managed_services`, so it was never a live
> addon. It is struck from the enumerations below rather than left as a service that no longer
> exists. The historical Signal design lives in `2026-05-10-signal-device-pairing-design.md`.

Both go through one registry, one dependency graph, one health model, one reconciler. Nothing is sideloaded at build time; everything is spawned at runtime.

### 1.2 Explicitly out of scope

- The sessions REST surface / multi-conversation (`session.new`, `conversation.activate`, `sessions.*`). Still later scope; the E2E rows that need it are marked BLOCKED, not skipped.
- Signing/notarising the compiled binary. Worth doing; not required for a LAN-only mini.
- Migrating searxng off Docker. It is third-party; Docker is the right packaging for it.

---

## 2. Topology

```
launchd  (root-owned plist, runs as the operator's user)
  └─ sentient-gateway                  native compiled binary — the host orchestrator
       ├─ NATIVE addons                via new native-driver.ts
       │    ├─ whisper-stt             python venv, pinned 3.14
       │    └─ local-tts               python venv, pinned 3.11
       ├─ DOCKER addons                via existing docker-driver.ts
       │    ├─ ha-mcp · ma-mcp · fetch-mcp · searxng-mcp
       │    ├─ searxng
       │    └─ egress-proxy            sole outbound path, unchanged
       └─ hermes                       NOT a managed service — one-shot exec per delegateTask
```

**Hermes is deliberately absent from the service registry.** In 2.0 it is `hermes -p <userId> -z <prompt>`, invoked and exited: no lifecycle, no port, no health check. Registering it would resurrect the per-user worker fleet 2.0 deleted.

**Supervision:** native addons are gateway-spawned children (`Bun.spawn`; restart on crash; SIGTERM→SIGKILL on shutdown), mirroring the docker driver's lifecycle. One supervisor chain: `launchd → gateway → {containers, native processes}`.

Accepted cost: native addons die with the gateway, so a gateway crash briefly takes voice down. The gateway MUST NOT orphan children when SIGKILLed — spawn into a process group and reap on boot.

**Assumption:** the mini auto-logs-in, so Docker Desktop's user session exists before the LaunchDaemon starts.

---

## 3. Network exposure

| Component | Bind | Reachable from |
|---|---|---|
| gateway | `0.0.0.0:8888` | LAN — intended; clients connect |
| whisper-stt · local-tts | `127.0.0.1` | localhost only |
| every docker addon | `127.0.0.1:<port>:<port>` | localhost only — **never LAN** |
| egress-proxy | unchanged | sole egress; `internal: true` stays |

Today MCP containers publish nothing and the gateway reaches them by docker DNS. Once the gateway is on the host that DNS is gone, and on macOS Docker Desktop bridge IPs are not routable from the host — so publishing is unavoidable.

**The safe form is binding to `127.0.0.1`, never `0.0.0.0`.** Docker's default publish exposes on all interfaces; that would put every MCP on the LAN.

This changes the `mcp-deployment.md` rule from "MCP containers publish NO host ports" to "loopback-only ports". The intent — MCPs are not LAN-reachable — is preserved; only the mechanism changes. **Any `ports:` entry lacking a `127.0.0.1` prefix is a defect.**

Egress is unaffected: an inbound loopback publish does not change `internal: true` or the egress-proxy path.

---

## 4. Filesystem layout & privilege separation

```
/opt/sentient/                        root:wheel 0755    CODE — immutable to the service user
  1.13.0/
    bin/sentient-gateway              compiled binary, Bun runtime baked in
    share/{templates,system_prompts,persona.md,webui}
    hermes/venv/                      python (pinned)
    whisper-stt/venv/                 python 3.14
    local-tts/venv/                   python 3.11
  1.12.0/                             retained for rollback
  current -> 1.13.0                   root-owned symlink

~/.sentient/                          user-owned         STATE — mutable
  gateway/{config,users,logs,data}
  secrets/keys.yaml                   0600
  certs/  run/  state.yaml

/Library/LaunchDaemons/io.sentient.gateway.plist   root:wheel 0644
```

**Rationale.** Apple's guidance for launchd jobs is that the executable's directory *and all parent directories* be writable only by root, and warns against privileged code in admin-writable locations. A binary under `$HOME` is writable by the very user it runs as: any compromised process rewrites it and gains persistence. A symlink in a user-writable directory has the same flaw — repointing it *is* the attack. Both are fixed by root ownership of the target **and** its parents; upgrading then requires `sudo`.

`/opt` over `/usr/local`: Apple suggests `/usr/local/<product>`, but it is regularly corrupted or removed by other tooling, which is why Homebrew moved to `/opt/homebrew` on Apple Silicon.

**LaunchDaemon, not LaunchAgent** — `~/Library/LaunchAgents/` is user-writable, the same hole. The daemon plist is root-owned and runs unprivileged via `UserName`.

Per-service pinned interpreters carry forward verbatim. `local-tts` requires 3.11 specifically: mlx-audio ships no 3.14 wheels.

**Invariant: code is root-owned and immutable; state is user-owned and mutable. Nothing executable lives under `$HOME`.**

---

## 5. Build & release

**Dev path is unchanged** — `bun --hot src/main.ts` from the checkout. Hot reload, no build step. The native driver launches STT/TTS from repo-local venvs. Fast iteration is the point.

**Prod path** — `./scripts/build-gateway.sh [--release] [--deploy]`, mirroring the existing `build-android.sh` / `build-ios.sh` convention.

| Variant | Flags | Use |
|---|---|---|
| debug | `--compile --sourcemap=inline` | default; readable stack traces |
| release | `--compile --minify --bytecode` | prod; `--bytecode` moves parse/transpile to build time, cutting startup |

Both machines are arm64 macOS, so **no cross-compilation**.

**Verified:** `bun build --compile` succeeds on the gateway today — 959 modules, one 65 MB executable, and it does **not** need the `--external cpu-features --external ssh2` flags the Dockerfile carries. The compiled binary runs; the only portability constraint is that module-scope `readFileSync` calls resolve against `import.meta.dir`, which differs inside a compiled binary. Setting `GATEWAY_RUNTIME_DIR` to the asset root fixes it — exactly what the Dockerfile already does with `ENV GATEWAY_RUNTIME_DIR=/app`.

### 5.1 Nothing fetches at deploy time

Both runtimes must satisfy this, or the property only half-holds.

- **Bun:** `--compile` embeds every JS dependency. No `bun install`, no `node_modules`, no Bun on the mini. Supply-chain exposure moves entirely to build time.
- **Python:** the build step runs `pip wheel -r requirements.lock -w vendor/wheels` per service; the installer runs `pip install --no-index --find-links=vendor/wheels`. Requirements are fully pinned and hash-checked. **No PyPI access on the mini.**

Wheels are built on the dev Mac against each service's pinned interpreter — same arch and Python version as the target, so they are binary-compatible.

---

## 6. The `native` launch type

Everything above the driver is already driver-agnostic: `dep-graph.ts`, `health.ts` (`url | tcp | exec | noop`), `service-registry.ts`, `boot-reconciler.ts`. Only the driver and the config schema are docker-shaped.

### 6.1 Config

`ManagedServiceConfigSchema` becomes a discriminated union on `launch`, defaulting to `docker` so every existing entry keeps parsing unchanged:

```yaml
managed_services:
  ha-mcp:
    launch: docker                    # implicit default — existing entries untouched
    template: ha-mcp.yaml
    allowed_images: ["sentient/ha-mcp:local"]
    networks: ["sentient-internal"]
    healthcheck: { tcp: "127.0.0.1:8086", timeout_ms: 30000 }

  whisper-stt:
    launch: native
    exec: ["${SENTIENT_CODE}/whisper-stt/venv/bin/python", "-m", "whisper_stt"]
    python: "3.14"                    # pinned; installer verifies
    env: { ... }
    healthcheck: { tcp: "127.0.0.1:8766", timeout_ms: 30000 }
    depends_on: []
    optional: false
```

### 6.2 Driver interface

`DockerDriver` today is `recreate | start | stop | remove | pullImage | listManaged`. `pullImage` is the only docker-specific member, and it has an exact native analogue — *ensure the artifact is present*. It generalises to `prepare`:

| op | docker | native |
|---|---|---|
| `prepare` | pull image | verify venv + pinned interpreter |
| `recreate` | recreate container | respawn process |
| `start` / `stop` | container start/stop | `Bun.spawn` / SIGTERM→SIGKILL |
| `remove` | remove container | reap PID, clear handle |
| `listManaged` | `listContainers` | in-memory PID table |

`tcp` health checks work unchanged for STT and TTS. Ordering, dependency blocking and boot reconciliation need no changes.

---

## 7. Installer (`setup-prod.py` rewrite)

Stops being a compose orchestrator; becomes an installer run under `sudo`:

1. Verify tarball checksum; refuse on mismatch.
2. Create `/opt/sentient/<version>` (root:wheel 0755); unpack binary + assets.
3. Build venvs **offline** — `pip install --no-index --find-links=vendor/wheels`, each on its pinned interpreter.
4. Ensure `~/.sentient/` state dirs exist, user-owned, `secrets/` 0600. **Never overwrite existing operator config.**
5. Install `/Library/LaunchDaemons/io.sentient.gateway.plist` (root:wheel 0644, `UserName` = operator).
6. Flip `current`; `launchctl kickstart -k`.
7. Health-gate on `https://localhost:8888/api/v1/health`; **auto-rollback** to the prior symlink target on failure.
8. Retain the last N releases; prune older.

Idempotent — re-running is safe. Rollback is flipping the symlink and kickstarting.

---

## 8. Deletions & config audit

### 8.1 Delete

| Removed | Why |
|---|---|
| `gateway/Dockerfile`; `gateway` service in both compose files | gateway is native |
| `deploy/hermes-overlay/`; `hermes` compose service | hermes is a one-shot exec |
| legacy `stt-service` compose service | superseded by native whisper-stt |
| `admin/supervisord-control.ts`, supervisord templates, `sentient-supervisor` volume | no per-user hermes daemon exists |
| `admin/user-port-store.ts` and its consumers | ports existed only for the ACP daemon |
| `renderProgramsForExistingUsers` (supervisord programs only) | nothing to supervise |
| `session-router.ts` (legacy ACP router, already nullable) | no ACP wire in 2.0 |
| `hermes.worker.port_base` and supervisord config keys | unread after the above |

### 8.2 Keep — verified, not assumed

`profile-store`, `renderInnerProfile`, `renderConfigsForExistingUsers` **stay**. `hermes-runner` sets its subprocess `cwd` to `resolveProfileDir(userId)` and its own comment states "the profile must already exist" — the one-shot path still requires a rendered per-user hermes profile. Deleting profile rendering would break `delegateTask` in a way no unit test covers.

All `gateway/mcp/*/Dockerfile`, searxng and egress-proxy stay: third-party or isolation-critical.

### 8.3 Config audit

`gateway/config.yaml` carries legacy blocks to reconcile: `cerebrum:` (already marked "do not add new keys"; 2.0 rehomed everything under `orchestrator:`), `hermes:` (loses worker/supervisord keys), and `apply:`. **Each key is checked for a live reader before removal** — deletion on suspicion is how a working feature dies silently. This is its own task, not a side-effect of another.

### 8.4 Docs & rules sweep

`mcp-deployment.md` (no-host-ports → loopback-only), `e2e-testing.md` (compose bring-up → native launch), `CLAUDE.md`, `deploy/README.md`, compose headers, and any `docs/` reference to the gateway image. A rule describing a dead mechanism is worse than no rule.

---

## 9. E2E acceptance

The 2.0 matrix (predecessor spec §10.1) was never executed, because it needs delegation to be real. **It is this project's acceptance criteria.** Plan 3's T11/T12 fold in here.

### 9.1 What the migration changes

| Previously blocked on | After migration |
|---|---|
| Hermes absent from the gateway image → `delegate-hermes-bg`, `steer-midloop`, interrupt's background-cancel arm | **UNBLOCKED** — gateway and hermes share a filesystem |
| Bring-up (`docker compose up` for the gateway) | **Replaced** — native launch; every case's pre-state changes |
| Acoustic mic onset in headless Chromium → `barge-in`'s real trigger | **Still blocked** — browser limitation, not deploy shape → **operator handoff (§9.4)** |
| `compact_threshold_tokens: 24000` untuned vs the real model window | **Agent closes it** — tune against the live model as part of the E2E slice |
| `session.switched` / past-chat rows → sessions REST surface | **Out of scope** — later project; recorded, never silently skipped |

### 9.2 Matrix

Fixed columns per the e2e rule: `Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail`.

| Case | Surface | Agent-drivable? |
|---|---|---|
| native-turn-happy | web desktop+mobile, native | yes |
| native-tool-call | web, native | yes — MCPs on loopback |
| delegate-hermes-bg | web | yes — **newly unblocked** |
| permission-confirm | web desktop+mobile, **native (spec-matrix gap — added)** | yes |
| barge-in (UI stop arm) | web, native | yes |
| barge-in (acoustic mic-onset arm) | web, native | **no → operator handoff §9.4** |
| interrupt | web | yes, incl. background-cancel arm (**newly unblocked**) |
| steer-midloop | web | yes — **newly unblocked** |
| steer-followup-audio | web, native | yes |
| reload-convergence | web, native | yes |
| compaction-continue | web | yes, after the agent tunes the threshold against the live model |
| voice-roundtrip | native (PCM fixture injection) | yes |
| restart-persistence | web | yes — now exercises `launchctl kickstart` |
| multi-user-isolation | web | yes |
| session-switch / past-chat | web, native | **no → out of scope** (needs the sessions REST surface) |

Web runs via Playwright MCP at 1280×900 and 390×844; native mobile via warm Maestro tag batches (`qa/mobile/run-e2e.sh --tags`). Every reusable case in `agents/docs/testing-knowledge.md` was authored against the retired cerebrum/cycle wire and must be **re-grounded** to `turnId` / `turn.*` frames and the 2.0 log tags before it is a valid regression guard.

**A case is green only when both the user-visible behaviour and the log trail match, with no unexpected WARN/ERROR.**

### 9.3 Migration-specific cases

Beyond the 2.0 matrix, the migration itself needs proving:

| Case | Expected | Agent-drivable? |
|---|---|---|
| native-addon-lifecycle | gateway start brings up whisper-stt + local-tts; health goes green; gateway stop reaps both, no orphans | yes |
| addon-crash-restart | `kill -9` a native addon → driver restarts it; health recovers | yes |
| loopback-only-exposure | every docker addon port answers on `127.0.0.1` and **refuses** on the host's LAN IP | yes (both probes run from the mini) |
| code-immutability | the service user cannot write `/opt/sentient/current/bin/sentient-gateway` | yes |
| upgrade-rollback | install N+1, health fails → auto-rollback to N; service healthy on the old version | yes |
| offline-install | installer completes with the network **disabled** — proves nothing fetches at deploy | yes |

### 9.4 Operator handoff — the only cases an agent cannot close

**The plan is fully agentic until this list.** Every other case above is executed and verified by the agent, to green, before this handoff is produced. These remain because they need physical hardware or a second machine, not because they were skipped.

The agent's final deliverable is this checklist, pre-filled with exact steps and the log lines to look for, so verification is a few minutes of the operator's time rather than a reconstruction:

| # | Case | Why an agent cannot do it | Operator steps |
|---|---|---|---|
| 1 | **Acoustic barge-in** — real speech over live TTS | Needs a real microphone picking up real speaker output. Headless Chromium has no mic; fake-device flags do not reproduce acoustic echo, which is the actual thing under test. | With TTS speaking a long reply, speak over it. Expect: audio stops within ~200 ms, the partial reply is committed with `cutoff: "barge-in"`, and any background task keeps running. Log: `turn.aborted{cutoff:"barge-in"}` + `playback.stop`. |
| 2 | **Acoustic barge-in on a physical phone** | Simulators have no real audio path; the `physical-only` Maestro tag exists for exactly this. | Same as above on a real Android/iOS device. Confirms the client flushes its queue and does not resume. |
| 3 | **LAN-exposure negative check from another device** | The agent probes the LAN IP from the mini itself, which proves the bind. Proving unreachability *from elsewhere* needs a second machine. | From a laptop on the same LAN: every MCP port must refuse; only `8888` answers. |
| 4 | **Echo-cancellation quality under real acoustics** | Subjective, and hardware/room-dependent. | Hold a normal voice conversation; confirm the assistant does not barge-in on its own TTS. |

Anything the agent discovers mid-run that turns out to need hardware is **added to this list rather than silently dropped** — the handoff is the single place unverifiable work is allowed to live.

---

## 10. Risks

- **Gateway crash takes voice down.** Accepted for the single-supervisor model; addon restart-on-crash limits the window. Revisit only if it bites in practice.
- **Orphaned addons on SIGKILL.** The gateway cannot run a shutdown hook when SIGKILLed; native addons must be spawned into a process group and reaped on next boot.
- **Docker Desktop needs a login session.** Mitigated by the auto-login assumption. A power cut with auto-login disabled leaves docker addons down while the gateway runs — the gateway must degrade rather than fail to boot.
- **Loopback publishing is one typo from LAN exposure.** `0.0.0.0` is docker's default. Enforced by the `loopback-only-exposure` E2E case, not by review alone.
- **Wheel/interpreter drift.** Wheels built against a different Python minor than the target fail at install. The installer verifies the pinned interpreter before installing.
- **Deleting a config key with a live reader.** Mitigated by §8.3's read-before-delete rule.

---

## 11. Build order

0. **Native driver** — `launch` discriminator, `native-driver.ts`, `prepare` rename; STT/TTS entries in `managed_services`. Gateway still containerised; both drivers exercised.
1. **Compiled binary** — `build-gateway.sh` with debug/release variants; `GATEWAY_RUNTIME_DIR` asset resolution; locked + vendored Python wheels.
2. **Native gateway** — launchd plist, `/opt/sentient` layout, loopback publishing for docker addons, removal of the gateway container. **`delegateTask` works end to end here.**
3. **Installer** — `setup-prod.py` rewrite: install, upgrade, health-gate, auto-rollback, prune.
4. **Deletions & audit** — supervisord fleet, port store, ACP router, stale config keys (read-before-delete), docs/rules sweep.
5. **E2E** — migration cases (§9.3), then the full 2.0 matrix (§9.2), web then native, serialized against the one stack. Ends by emitting the §9.4 operator handoff checklist.

Slices 0–1 are additive and safe to land independently. Slice 2 is the cutover. Slice 5 is the acceptance gate for both this spec and its predecessor.

**Every slice is agent-executable end to end.** The single handoff point is §9.4, produced as the last artifact — so the plan runs to completion without human intervention, then hands over a short, pre-filled list of what genuinely needs hands and hardware.
