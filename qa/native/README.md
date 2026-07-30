# Native-stack QA harness

Verification that only a real docker daemon (or a real gateway process) can
give. Everything here mutates containers or spawns real processes, so it is
**local dev stack only** — never `mini0.lan` / `sentient.dev32.io`, where
agent actions are observational.

| File | What it does |
|---|---|
| `apply-addons.ts` | Drives the **real** system orchestrator against the shipped `gateway/config.yaml` + `gateway/templates/services/`. Applies the named services as a subset, in dependency order, and exits non-zero unless every required one reaches `ready`. |
| `verify-ingress-confinement.sh` | Proves both halves of the ingress-proxy design: the gateway can reach the MCPs, and the MCPs still cannot egress. |
| `evidence/<date>-<case>/` | Per-case captured output + log excerpts for the six migration E2E cases below (gitignored — see `.gitignore` in this dir). |

```bash
source scripts/env.sh
./qa/native/verify-ingress-confinement.sh          # gateway must NOT be running
```

`apply-addons.ts` exists so an addon-topology change is verified through the
production path — `docker-driver`, its publish/network guards, the health probes
— rather than through hand-written `docker run` commands that prove only what the
author remembered to type. It reads the gateway's own internal-secrets store, so
searxng is recreated with the secret the gateway already knows rather than a
fresh one.

## One-time migration: releasing a moved host port

Docker allows exactly one holder per host port. On a host that ran the
**pre-ingress-proxy** shape, `sentient-fetch-mcp` and `sentient-searxng-mcp`
still publish `127.0.0.1:8088` / `:8087`, so `ingress-proxy` cannot bind them and
fails with:

```
failed to set up container networking: driver failed programming external
connectivity on endpoint sentient-ingress-proxy ... port is already allocated
```

The apply recreates those two containers anyway, so removing them first *is* the
whole migration:

```bash
docker rm -f sentient-fetch-mcp sentient-searxng-mcp
```

`verify-ingress-confinement.sh` does this as its first step and it is a no-op on
a host that never ran the old shape. Note the ordering cannot be expressed with
`depends_on`: `ingress-proxy` must come up **before** the MCPs for reachability,
so making it wait for them would be a dependency cycle.

## Recorded run — 2026-07-29, docker 29.2.1, Docker Desktop / macOS

```
=== release the host ports ingress-proxy is taking over (one-time migration) ===
removing sentient-fetch-mcp — it still publishes a port the proxy now owns
removing sentient-searxng-mcp — it still publishes a port the proxy now owns

=== apply the shipped addon topology through the real orchestrator ===
[system-orch:docker-driver] driver.ports-published | service="ingress-proxy" ports=127.0.0.1:8088:8088,127.0.0.1:8087:8087
[qa:apply-addons] apply.result | service="egress-proxy"  state="ready" optional=false lastError=null
[qa:apply-addons] apply.result | service="ingress-proxy" state="ready" optional=false lastError=null
[qa:apply-addons] apply.result | service="fetch-mcp"     state="ready" optional=false lastError=null
[qa:apply-addons] apply.result | service="searxng"       state="ready" optional=false lastError=null
[qa:apply-addons] apply.result | service="searxng-mcp"   state="ready" optional=false lastError=null
PASS  every required addon reached ready

=== fetch-mcp is attached to the no-egress network ONLY ===
networks: sentient-internal
PASS  sentient-internal only

=== fetch-mcp publishes NO host port ===
docker port: ""   PortBindings: map[]
PASS  no host publish

=== THE POINT: fetch-mcp cannot egress with the proxy env unset ===
route probe: EGRESS-BLOCKED OSError
PASS  no route to 1.1.1.1:443 — confinement is network-enforced

=== fetch-mcp still reaches the internet THROUGH egress-proxy ===
proxied fetch: PROXIED-OK 200
PASS  the one permitted path out still works

=== the gateway can reach both MCPs through the proxy (real MCP handshake) ===
fetch   (127.0.0.1:8088): "serverInfo":{"name":"mcp-fetch","version":"1.27.1"}
searxng (127.0.0.1:8087): "serverInfo":{"name":"SearxNG Search Server","version":"3.2.4"}
PASS  both answered initialize through ingress-proxy

=== ingress-proxy is the ONLY container spanning both networks ===
spanning both: sentient-ingress-proxy sentient-egress-proxy
PASS  ingress-proxy spans both, as designed

=== the proxy follows an addon that MOVES (the reason for the runtime resolver) ===
fetch-mcp 172.20.0.5 -> 172.20.0.7   (placeholder holds 172.20.0.5)
PASS  reached the moved container through an unrestarted proxy

===== ALL CHECKS PASSED =====
```

Two of these cases are worth knowing about:

**The egress probe uses `python3`, not `curl`, deliberately.** `curl` is not
installed in `sentient-fetch-mcp` (`python:3.13-slim`), so
`docker exec ... curl ... || echo "no route"` exits 127 and prints the
success message on a container that egresses freely. It probes a literal IP
(`1.1.1.1:443`) so a failure means *no route* rather than *DNS is broken*, and
the following case proves the permitted path out still works — a boundary that
blocks everything is not the goal.

**The move case forces the IP change rather than hoping for it.** Docker reuses a
freed address, so a plain recreate usually lands on the same IP and proves
nothing; the harness parks a placeholder container on the vacated address first
and asserts the proxy was never restarted. This is what justifies the runtime
`resolver` in `gateway/mcp/ingress-proxy/nginx.conf`: with a literal upstream
name, nginx resolves once at startup and caches for the process lifetime, so
after any addon recreate it would keep dialling a dead address with no error
until a tool call failed.

---

## Migration E2E cases (2026-07-29, native-stack-migration Task 8)

Six cases proving the migration itself — these run **before** the 2.0 web/native
matrices (Tasks 9/10), because a red migration case makes every later row
untrustworthy. Full per-case evidence: `evidence/2026-07-29-<case>/README.md`.

**No root on this dev box** (confirmed: `sudo -n true` / non-interactive `sudo`
both refuse — no cached credential, no askpass helper; T4 and T5 hit and
documented the identical wall). Cases that fundamentally require root are
BLOCKED with a real rootless substitute run wherever one exists and can prove
the same code path; cases that don't need root were driven for real, including
against a genuine (if unprivileged) `launchd` job — see each evidence README
for exactly what ran and why.

`addon-crash-restart` and `loopback-only-exposure` both FAILED on their first
drive. Task 8b fixed what they found and **re-drove both against a real running
stack** — the rows below carry the re-drive result and name the fix commit; each
evidence README keeps the original failure analysis underneath, since that is the
record of why the fix was needed. `code-immutability` and `offline-install`
remain BLOCKED on genuine root and are T11 operator-handoff items, not things to
force from an unprivileged agent.

| Case | Result | Notes |
|---|---|---|
| `native-addon-lifecycle` | **PASS** | Driven under a rootless `gui/<uid>` launchd rehearsal (real compiled binary, `KeepAlive=true`). Startup: both `native.started` + `registry.built` real. Shutdown: "no orphans" holds, but via `KeepAlive` auto-restart + next-boot `reapOrphans()` — the gateway's own SIGTERM handler does not itself stop the native children. |
| `addon-crash-restart` | **PASS** (re-driven 23:48 after fix `5e585db`) | Originally FAILED: no periodic health-watch existed, so a crashed addon stayed down (verified 65s, zero recovery). Re-driven with the gateway as **sole** supervisor (both addon LaunchAgents booted out, so `KeepAlive` could not fake the recovery). `kill -9` local-tts → `native.exited` 23:48:38 → `service.unhealthy reason="health-probe-failed" attempt=1` 23:48:52 → `apply.start targets=local-tts mode="subset"` → `native.started pid=65557` → ready 23:48:55 (+16.9s) → `service.recovered reason="healthy-after-reapply"`. Healthy sibling never touched; new process still binds `127.0.0.1`. Docker driver proved separately via `docker rm -f sentient-ha-mcp` (restart policy cannot cover a removed container) → recreated in 3.3s. |
| `loopback-only-exposure` | **PASS** (re-driven 23:45 after fix `68d67fd`) | Originally FAILED: whisper-stt bound `*:8768` because its `config.example.yaml` still carried the container-era `host: "0.0.0.0"`. Re-driven against the real stack with the gateway as sole supervisor: all 8 addon ports (4 docker, 4 native — WS **and** health) answer on loopback and refuse on `192.168.0.197`; `lsof` confirms `127.0.0.1:` binds, not `*:`. The gateway's own `*:8888` is the only wildcard listener, as required. |
| `code-immutability` | **BLOCKED** | No rootless equivalent exists — the assertion IS root ownership. Needs a real `sudo setup-prod.py install` first-run (mini or an agent with real sudo). |
| `upgrade-rollback` | **PARTIAL** | Installer FSM (checksum, health-gate, rollback, idempotency, prune, config-preservation) proven for real via `deploy/mac-prod/tests/e2e-install.sh` (T5's rootless harness) against a real built release. Root-only remainder (`chown -R root:wheel`, the `system` domain, `UserName` switching) still needs a real first run. |
| `offline-install` | **BLOCKED** | Same root wall as above. Structural evidence only: `install-venv.sh` uses `pip install --no-index --find-links=`, making PyPI access impossible regardless of network state (already proven live by T3). Did not toggle Wi-Fi off — moot given the root block, and a needless risk to this box's own connectivity. |

Two collateral defects surfaced while getting `native-addon-lifecycle` to boot
cleanly under real launchd conditions (no `WorkingDirectory`, compiled-binary
`import.meta.dir` is bunfs-virtual). Both were **fixed in `f46e780`**; the trace
that found them is in that case's evidence README:
- `startup-config.ts` defaulted `LOG_DIR`/`GATEWAY_CERTS_DIR` to relative paths
  that resolved to `/logs` / `/certs` (EROFS, crash-loops) unless the plist set
  them explicitly, which the shipped plist didn't. Both now default to absolute
  paths under `~/.sentient/gateway/`, and the plist sets them too.
- `create-gateway-services.ts` defaulted `hostConfigDirContainerPath` to a
  literal `/sentient` (a pre-migration "inside the container" assumption) when
  `SENTIENT_HOME` was unset; it now reuses the already-resolved state root.

Re-confirmed live during the Task 8b re-drive, on a rehearsal plist carrying
**no** `LOG_DIR`/`GATEWAY_CERTS_DIR` at all: the gateway logged to
`~/.sentient/gateway/logs/2026-07-29.log` and nothing was created at `/logs` or
`/certs`.

## One-time migration case: releasing the moved host ports

`docker rm -f sentient-fetch-mcp sentient-searxng-mcp` (see the "One-time
migration" section above) is itself a migration case, not just a pre-step: any
host that ran the pre-ingress-proxy shape needs it exactly once before the new
topology can apply. Already proven idempotent and a no-op on a host that never
ran the old shape — see the "Recorded run" transcript above, and re-confirmed
during this Task 8 run (the same box, same ports, already-migrated: `docker ps`
showed `sentient-ingress-proxy` holding `127.0.0.1:8087-8088` and
`fetch-mcp`/`searxng-mcp` publishing no host port at all).
