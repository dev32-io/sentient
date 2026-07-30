# Native-stack QA harness

Verification that only a real docker daemon can give. Everything here mutates
containers, so it is **local dev stack only** — never `mini0.lan` /
`sentient.dev32.io`, where agent actions are observational.

| File | What it does |
|---|---|
| `apply-addons.ts` | Drives the **real** system orchestrator against the shipped `gateway/config.yaml` + `gateway/templates/services/`. Applies the named services as a subset, in dependency order, and exits non-zero unless every required one reaches `ready`. |
| `verify-ingress-confinement.sh` | Proves both halves of the ingress-proxy design: the gateway can reach the MCPs, and the MCPs still cannot egress. |

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
