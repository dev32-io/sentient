# Inbound Proxy, Web Serving, and One-Command Launch — Design

**Date:** 2026-08-04 (rewritten 2026-08-04 after a Codex review and a second design pass)
**Branch context:** written on `feature/native-orchestrator`; independent of the session-model wave.
**Status:** design approved in discussion, not yet planned or implemented.

**Goal:** one outward-facing door for the whole stack — so `https://<host>` reaches the web UI, so the web UI is served at all, and so one command brings the whole local stack up the same way production does.

---

## 1. What we have today

Established by inspection. Three of these are defects.

### 1.1 The gateway serves the API on one port, on every interface

`gateway/config.yaml:12-13` sets `port: 8888` and `host: 0.0.0.0`. Same value in dev and prod — there is no per-environment port. `gateway/src/server.ts:191` passes that straight to `hostname`, so today the gateway is reachable from the LAN with no policy in front of it.

TLS is terminated by the gateway itself. `gateway/src/bootstrap/phase-services.ts:150-152` calls `ensureTlsMaterial()` — **gated on `cfg.tls.enabled`** — which mints a self-signed CA into `cfg.tls.certsDir`, producing `cert.pem`, `key.pem`, and `san.txt` (`shared/tls/src/tls.ts:50`). `deploy/mac-prod/io.sentient.gateway.plist:67` points `GATEWAY_CERTS_DIR` at `~/.sentient/gateway/certs`. `setup-prod.py` pins its post-install health probe to that same `cert.pem` as a trust anchor.

That gating is load-bearing for §2.5: **turning the gateway's TLS off would stop the cert being minted at all.**

### 1.2 The web UI is served nowhere — the real hole

`gateway/src/server.ts:152` builds the static handler from `services.webDistDir`. That value is `process.env.WEB_DIST_DIR` (`gateway/src/config/startup-config.ts:176`), and **`WEB_DIST_DIR` is set nowhere in the repository** — not in the plist, not in `scripts/env.sh`, not in any compose file.

The consequence is more precise than "the handler is null". `createWebuiHandler` (`gateway/src/api/handlers/webui.ts:50`) always returns a function; with `distDir` undefined that function returns `null` for **every request**, so the router falls through to a 404. Same outcome, different mechanism — and the distinction matters because the fix is a value, not a wiring change.

In dev this is invisible: vite owns the UI on `http://localhost:5173` and proxies `/api/v1` to the gateway, so `https://localhost:8888/` legitimately 404s. In prod there is no vite, so **there is no UI on any port** — even though `scripts/build-gateway.sh:56` already copies `gateway/webui/dist` into `share/webui`, and `deploy/mac-prod/io.sentient.gateway.plist:46` already points `GATEWAY_RUNTIME_DIR` at that `share/`. The artifact is installed and addressable. Nothing reads it.

`deploy/README.md:112` already instructs operators to "Open `https://sentient.dev32.io` (port 443)". Nothing listens on 443. The documentation describes a stack we do not ship.

### 1.3 Addons are already loopback-only, by enforced policy

Every addon host port is published as `127.0.0.1:<port>:<port>`, and this is enforced in **three** places, not one:

| Site | Mechanism |
|---|---|
| `gateway/src/system-orchestrator/types.ts:97-100` | `LOOPBACK_PORT_RE` + `LoopbackPortSchema` |
| `gateway/src/system-orchestrator/template-loader.ts:69` | `enforceLoopbackPorts()`, pre-schema, so the error names the rule |
| `gateway/src/system-orchestrator/docker-driver.ts:280-290` | `buildPortPublishing()` re-tests the regex and writes `HostIp: LOOPBACK_HOST_IP` unconditionally |

The outward-facing surface of the whole stack is therefore **one port: the gateway's 8888**. The inbound proxy has exactly one upstream, not a fleet.

The network topology is likewise a closed set: `MANAGED_NETWORK_TOPOLOGY` (`types.ts:39-42`) declares exactly `sentient-internal` (internal) and `sentient-external` (not internal), and the driver fails closed on any membership outside it.

### 1.4 Boot reconcile is skipped on a fresh install

`gateway/src/bootstrap/phase-orchestrator.ts:330-343`: the boot reconcile that replays `applyAll` runs **only** when `bootstrap_complete` is true. On a fresh host the wizard owns the first apply, deliberately, so the bringup screen does not flash past.

This is the fresh-install deadlock. Bind the gateway to loopback without addressing it and a brand-new host has neither a LAN-reachable gateway nor a running proxy — **no route to the wizard from any device.**

### 1.5 Every gateway restart recreates the whole fleet

`gateway/src/system-orchestrator/orchestrator.ts:124` calls `drivers[...].recreate(ms)` for every service in the apply order, unconditionally. Under `bun --watch`, every source save restarts the gateway and therefore deletes and recreates every addon container. Today that is merely wasteful. Once a container holds 80/443, it means **every keystroke-save drops the public door.**

### 1.6 `ingress-proxy` is a different thing, and a misleading reference

`gateway/mcp/ingress-proxy/` is a stock `nginx:1.30-alpine` spanning the **internal addon network boundary**. It is not, and must not become, the public entrance.

It is the encapsulation precedent this design follows — stock upstream image, one declarative config, no code of ours, build fails on a malformed config. It is **not** a usable reference for WebSocket forwarding: `gateway/mcp/ingress-proxy/nginx.conf:38` sets `proxy_set_header Connection "";` and never sets `Upgrade`, because it carries MCP Streamable-HTTP/SSE, not upgrades. Copying it breaks `/api/v1/ws`.

### 1.7 Two cert stories, both live

- `~/.sentient/gateway/certs/` — self-signed, gateway-minted, what `setup-prod.py` pins.
- `~/.data/certs/sentient.dev32.io` — a **real** cert, renewed and rsynced by `acme.sh` on the LAN. `deploy/README.md:131` and `deploy/mac-prod/docker-compose.yml:39-41` both document it as the one intentional state path outside `~/.sentient`.

Both are real. They serve different roles, and this design is where that gets said out loud (§2.5).

### 1.8 Launch is split across four incantations

`bun run dev` (`package.json:10`) starts the gateway and vite, and relies on the gateway's boot reconcile for docker and native addons. It does **not** source `scripts/env.sh`, stage `SENTIENT_CODE`, build images, or verify Docker is up. A working local stack currently requires, in order and from memory:

```
source scripts/env.sh
scripts/dev-stage-code.sh                                             # once, needs venvs pre-built
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build
bun run dev
```

`scripts/env.sh:45` only *warns* when the native tree is unstaged. Miss any step and the stack comes up looking healthy while the orchestrator's whole native path goes unexercised — the failure mode `env.sh`'s own header comment documents at length.

---

## 2. The design

One container owns every outward-facing port. Everything else binds loopback.

```
LAN / browser ──▶ inbound-proxy :443  (+ :80 → 301)        ← the ONE public door
                       │  TLS terminated (outward identity)
                       │  re-encrypted, upstream verified
                       └──▶ https://127.0.0.1:8888 ──▶ gateway (native binary / bun)
                                                        ├── webui   ← assetPath("webui")
                                                        └── /api/v1 (+ws)

gateway         binds 127.0.0.1 only        (config.yaml:13, today 0.0.0.0)
every addon     binds 127.0.0.1 already     (unchanged)
inbound-proxy   is itself an orchestrator-managed addon, in a new INFRA class
```

**Dev and prod run the identical topology, with the identical proxy config.** That is the whole point of doing it in both places: a routing, header, or upgrade bug surfaces on the dev Mac instead of only on the mini.

### 2.1 Dev serves the built UI exactly like prod, with vite alongside it

The proxy has **one** upstream in both environments. Vite is not behind it and does not know it exists — it runs beside it, on its own port, always.

```
DEV — both doors up, always
  browser ─▶ inbound-proxy :443 ─▶ gateway :8888 ─┬─ webui (gateway/webui/dist)
                                                  └─ /api/v1 (+ws)
  browser ─▶ vite :5173 ─▶ /api/v1 ─▶ gateway :8888     side door, proxy uninvolved

PROD
  LAN     ─▶ inbound-proxy :443 ─▶ gateway :8888 ─┬─ webui (share/webui)
                                                  └─ /api/v1 (+ws)
```

Rejected: fronting vite from the proxy in dev. It gives the proxy a two-upstream routing table in dev and a one-upstream table in prod — precisely the divergence this design exists to kill — and drags HMR's websocket through nginx for no gain.

Both doors serve **current** code. `vite build --watch` runs as a third dev process, keeping `dist/` in step with source; the gateway serves that directory through `Bun.file`, read per request, so a rebuilt bundle needs no gateway restart — 443 picks it up on reload while 5173 has already hot-reloaded. It does not fight `bun --watch`, which tracks the gateway's own module graph; `webui/dist` is not in it.

Without that watcher the two doors drift, and the drift is silent: you would fix a bug at 5173, smoke at 443, and smoke the previous build. Since the entire argument for routing browser smoke through 443 is that it catches packaging, MIME, cache-header, and SPA-fallback regressions vite hides, a stale bundle there defeats the feature.

Three doors exist in dev, in increasing fidelity:

| URL | What it proves | When |
|---|---|---|
| `http://localhost:5173` | nothing about prod | UI iteration — instant HMR |
| `https://localhost:8888` | gateway static serving | diagnostics; works from the host even when loopback-bound |
| `https://localhost` | the real thing | **all browser smoke** |

`CLAUDE.md`'s standing instruction "Open the vite URL, never `:8888`" becomes wrong under this design and is updated as part of the work.

### 2.2 Who owns the proxy: the orchestrator, in a new INFRA class

`inbound-proxy` is an orchestrator-managed docker addon. It is not a compose service, not a second launchd job, not a bespoke supervisor. The gateway already is the host orchestrator; a second runtime owner would be exactly the rediscoverable divergence this design is trying to remove.

But three existing orchestrator behaviours are wrong for a public door. Rather than special-case one service name, introduce an explicit **`infra` service class** — a policy flag in `managed_services`, default false, whose only member today is `inbound-proxy`:

| Behaviour | Capability class (today) | `infra` class |
|---|---|---|
| First apply on a fresh host | waits for the wizard (`phase-orchestrator.ts:330`) | applied unconditionally at boot, after TLS material is minted |
| Watchdog exhaustion | gives up after `health_watch_max_attempts` (`health-watch.ts:138-176`) | never gives up; keeps retrying with the same widening backoff |
| Reconcile | unconditional `recreate` (`orchestrator.ts:124`) | skipped when the running container is unchanged **and** healthy |

Each row fixes a specific, verified failure:

- **Pre-bootstrap apply** closes §1.4's deadlock. Ordering is forced and cheap: `phase-services.ts:150` mints the cert before the orchestrator phase is constructed, so by the time an infra service starts, its cert already exists.
- **No give-up** matters because `docs/native-todo.md` already documents Docker Desktop starting *after* the LaunchDaemon on the mini, by a margin that can exceed the current backoff budget. Under today's rule the only public entrance would give up permanently and need a manual restart.
- **Skip-unchanged** fixes §1.5: without it every `bun --watch` save drops 80/443.

The skip must **not** skip `verifyIdentity` (`orchestrator.ts:148-157`). Proving something answers the port is not proving it is ours; that check exists because a whole fleet once reported ready while both native addons were dead. Skip the recreate, keep the identity proof.

**Accepted consequence:** the proxy's lifetime is the gateway's. Gateway down means no door and no maintenance page. This is correct — a door onto nothing serves no one — and is stated so it is a decision rather than a surprise.

### 2.3 The public-port exception

The loopback rule of §1.3 is a genuine security invariant and stays the default. It gains one narrow, fail-closed exception, expressed in policy (`config.yaml#managed_services`), not in the template:

- A service may declare non-loopback publishing **only** if its policy entry sets the public flag.
- The exception admits host ports **80 and 443 only**.
- All three enforcement sites read the same predicate, so the layers cannot drift — the existing reason `LOOPBACK_PORT_RE` is duplicated across schema, loader, and driver.

Inside the container nginx listens on unprivileged **8080/8443**; Docker maps host 80/443 onto them. Nothing in the image needs to run privileged.

Port 80 is kept. Codex proposed cutting it as YAGNI; it is not. A bare `mini0.lan` typed into a browser attempts HTTP first, and the 301 is the entire reason `https://<host>` works without the user typing a scheme. That is the ergonomic point of the feature.

### 2.4 Network: a new `sentient-edge`

`inbound-proxy` joins a new non-internal network `sentient-edge`, added to `MANAGED_NETWORK_TOPOLOGY` (`types.ts:39-42`).

It needs *a* non-internal network for publishing to take effect at all (docker silently drops publishing when every attached network is `internal: true` — the finding that produced `ingress-proxy`). It needs **no** container reachability whatsoever: its only upstream is host loopback. Reusing `sentient-external` would put the internet-facing container on the same L2 segment as `ha-mcp`, `ma-mcp`, `searxng-mcp`, and `egress-proxy`, granting lateral reach it has no use for. Its own network gives it exactly the reachability it needs and nothing else.

### 2.5 TLS — two roles, two answers

The proxy handles two distinct cert concerns. Conflating them is what produced §1.7's two competing stories.

| Role | Dev | Prod |
|---|---|---|
| **Outward identity** (443) | `~/.sentient/gateway/certs` — self-signed, accept the browser warning | `~/.data/certs/sentient.dev32.io` — the real acme.sh cert |
| **Upstream trust anchor** (→ 8888) | the gateway's self-signed `cert.pem` | the gateway's self-signed `cert.pem` |

The outward path is a config value with a **fallback to the gateway's self-signed material**. That fallback is not a nicety: a fresh mini before `acme.sh` has ever run has no real cert, and an infra-class service must still start. One code path, both environments, no first-boot hole.

**The upstream hop stays TLS.** Not a preference — a coupling. `phase-services.ts:150` gates cert minting on `cfg.tls.enabled`, so dropping the gateway to plaintext would stop the material being produced at all, including the material the proxy needs. Keeping TLS also leaves the gateway's listener untouched and preserves `setup-prod.py`'s existing verified-TLS health probe.

nginx verifies the upstream against the mounted `cert.pem` with an explicit `proxy_ssl_name`. The container dials the host, so the name it presents must be one the SAN actually contains — `shared/tls/src/tls.ts:28` always includes `localhost` and `127.0.0.1`, so `localhost` is the correct, always-present choice. Verification that silently degrades to encryption-only is the failure mode being guarded against here.

There is deliberately **no** "tolerate a missing cert, retry instead of crash-looping" requirement. The material is minted before the orchestrator phase is constructed (`phase-services.ts:150`, `create-gateway-services.ts`), and the prod path falls back to it, so no window exists in which an infra-class proxy starts without a cert.

**Known, not fixed here:** `shared/tls/src/tls.ts:60-85` never `chmod`s `key.pem`, so "the key is 0600" is an assumption, not an enforced fact. Enforcing the mode is a one-line addition and is in scope (§3); rotating or reloading on acme.sh renewal is not (§3, Out).

### 2.6 SAN, and where the microphone breaks

`gateway/config.yaml:56-58` ships `tls.hostnames: ["localhost"]`. `shared/config/src/schema.ts:212-214` records the consequence: a SAN mismatch produces *"a hard browser warning AND refuses mic access."*

This is a voice assistant, so it matters, but the blast radius is narrow:

- **Prod** — the real cert names `sentient.dev32.io`. No issue.
- **Dev, browser on the host** — `https://localhost` is in the SAN. No issue.
- **Dev, browser on a phone over the LAN** — SAN mismatch, **no microphone**. Workaround already documented at `config.yaml:58`: add the LAN IP to `tls.hostnames` and delete the certs dir to regenerate.
- **Native mobile apps** — unaffected. They use platform microphone permission, not browser origin rules.

No code change; the operator note is part of the doc work in §3.

### 2.7 Two measurements

The privileged-bind and loopback-reachability premises are measured, not assumed.

Loopback reachability from a container (2026-08-04, this Mac, Docker Desktop):

| Case | Host bind | Result |
|---|---|---|
| A | `127.0.0.1:9911`, confirmed via `lsof` | container reached it |
| B — control | `0.0.0.0:9912` | container reached it |
| C — negative control | nothing on 9913 | `Connection refused` |

C refusing proves A is not a false pass. The mechanism is visible in C's error: the container connects from `192.168.65.254`, Docker Desktop's host-side address, and its network stack proxies to host loopback. **This is Docker-Desktop-specific and would not work on native Linux** — that caveat belongs in a comment beside the bind, because someone will eventually try this on a Linux box.

Privileged bind (2026-08-04, same host):

| Check | Result |
|---|---|
| `docker run -p 0.0.0.0:443:80 nginx:1.30-alpine` | bound, no root prompt |
| `curl http://127.0.0.1:443/` | `200` |
| `lsof -nP -iTCP:443 -sTCP:LISTEN` | `com.docker`, **user-owned, not root** |

The conclusion holds but the previous draft's reasoning did not: on macOS the host listener is Docker Desktop's user-owned backend acting through its privileged helper, not "the daemon running as root". `pf` port-forwarding stays rejected — rules are lost on reboot unless anchored, the anchor is a second root-owned artifact, and it offers nowhere to terminate TLS or redirect `:80`.

### 2.8 Naming

Called **`inbound-proxy`**, per owner decision. `ingress-proxy` (internal addon-network boundary) and `inbound-proxy` (public host/LAN boundary) are near-synonyms guarding different boundaries, so each config carries a header comment naming which boundary it guards — the way `ingress-proxy`'s already does.

It does **not** live under `gateway/mcp/`. `ingress-proxy` sits there by accident of history; `inbound-proxy` has nothing to do with MCP.

---

## 3. Launching the stack

One command, one canonical URL, in dev and prod alike.

**Prod is already this shape** and does not change: `sudo launchctl kickstart -k system/io.sentient.gateway` starts the gateway, whose orchestrator creates every docker and native addon. `setup-prod.py` touches docker nowhere. Adding the proxy to the registry means prod gains a public door with no new prod launch step.

**Dev gets the equivalent.** `bun run dev` becomes the whole-stack launcher, delegating to `scripts/stack.sh` — a bash entry point so it can source `scripts/env.sh` itself and so it still runs before bun is on `PATH`.

```
bun run dev  ─▶  bash scripts/stack.sh up

  preflight ── AUTO ──  source env.sh · wait for the docker daemon
                        · bake missing/stale :local images (incl. inbound-proxy)
                        · kill a gateway we can PROVE is ours (~/.sentient/run/gateway.pid)

            ── REFUSE ─ bun missing · daemon still down after the wait
               with one  · venvs unstaged · ~/.sentient config absent
               runnable   · a FOREIGN process holding 80/443/8888/5173 —
               line         named via lsof, never signalled
      ↓
  start three processes ─┬─ bun --watch src/main.ts   gateway :8888 (+ addons, proxy)
                         ├─ vite dev                  :5173  live source, HMR
                         └─ vite build --watch        dist/ → :443 always current
      ↓
  gateway boot ──▶ orchestrator applies the INFRA class first, then the rest
      ↓
  readiness ── gateway /api/v1/health on loopback
               AND vite build --watch's FIRST pass complete (443 must serve something)
               AND https://localhost/ through the proxy
      ↓
  print ONE canonical URL:  https://localhost/
            side door:      http://localhost:5173  (HMR)
            diagnostics:    https://localhost:8888 (gateway-direct)
```

The auto/refuse split is the design's one judgement call. Auto-fix what is cheap, idempotent, and unambiguous. Refuse — loudly, with the exact command — where the fix needs the network, holds secrets, or would mean signalling a process we cannot prove is ours. The last is the existing native-addon rule (`config.yaml:762-768`: a holder recorded in `~/.sentient/run/<svc>.pid` is escalated; an unidentifiable holder is only named) applied to the gateway itself.

**Docker is a hard requirement.** No daemon means no MCP tools, no searxng, no egress-proxy, and now no door. A stack that "starts" without it is a lie that hides orchestrator bugs, so preflight waits briefly and then refuses with `open -a Docker`. Prod always has Docker up; dev matches.

**Re-running is restarting.** `bun run dev` against a live stack restarts it. One command to remember, which is the entire ergonomic goal.

**Stop semantics, documented because they are asymmetric:**

| Action | Gateway | Vite (both processes) | Native addons | Docker addons |
|---|---|---|---|---|
| Ctrl-C on `bun run dev` | stops | stop with the process group | reaped by the SIGTERM hook (`main.ts:306-307`) | **keep running** (`unless-stopped`) |
| `bun run stack:down` | stops | stop | reaped | stopped |

Containers surviving Ctrl-C is what makes restart fast, and `boot-reconciler` re-adopts them. It is only confusing when undocumented. `stack.sh` traps its own exit to kill the process group, as `package.json:10` already does today.

Commands: `bun run dev` (up / restart) · `bun run stack:down` · `bun run stack:status`.

---

## 4. Scope

**In:**

1. **Serve the UI.** `webDistDir` derived from the asset root (`assetPath("webui")`), `WEB_DIST_DIR` demoted to an override. Must handle both shapes: `share/webui` in an installed release, `gateway/webui/dist` in a repo checkout — `assetPath("webui")` alone resolves to the *source* directory in a checkout.
2. **`inbound-proxy` addon.** Stock nginx, one baked config, infra class, `sentient-edge`, 8080/8443 internally mapped to host 80/443, outward cert from config with fallback, verified TLS upstream, correct `Upgrade`/`Connection` handling for `/api/v1/ws` (**not** copied from `ingress-proxy`), `Host` validation, and `X-Forwarded-*` / `X-Real-IP` **overwritten** rather than appended.
3. **The public-port exception** at all three enforcement sites (`types.ts:97-100`, `template-loader.ts:69`, `docker-driver.ts:280-290`), plus `sentient-edge` in `MANAGED_NETWORK_TOPOLOGY`.
4. **The infra service class**: pre-bootstrap apply, no watchdog give-up, no recreate when unchanged and healthy — while still running `verifyIdentity`.
5. **Bind change**: `config.yaml:13` → `127.0.0.1`, **plus an operator-config migration**. The chain in `gateway/src/config/operator-config-migrator.ts` currently ends at 0.1.3 and never touches `host`; production reads a seeded, never-overwritten operator config, so without a 0.1.3 → 0.1.4 step every existing install silently stays on `0.0.0.0`.
6. **Mobile defaults → 443** (`android/.../BackendSetupViewModel.kt:28`, `ios/App/SDK/GatewayConfig.swift:16`, and the URL builders that interpolate `:$port`). No migration machinery — an already-paired device is re-pointed from its own settings screen.
7. **`key.pem` mode enforced** to 0600 in `shared/tls/src/tls.ts`, which currently only assumes it.
8. **Launcher**: `scripts/stack.sh` + `bun run dev` / `stack:down` / `stack:status`, running the gateway, `vite dev`, and `vite build --watch` as one process group.
9. **`setup-prod.py` health gate through 443**, not only 8888. Today `gateway/src/api/handlers/health.ts` returns 200 as soon as the process is up and the installer probes 8888 directly, so a broken nginx config, a missing bundle, a wrong cert, or broken WS forwarding would all pass the gate and never trigger the rollback that exists to catch exactly this.
10. **Doc reconciliation**: `CLAUDE.md`'s "never open `:8888`", the two cert stories of §1.7, the SAN note of §2.6, and the native-stack migration spec's stale `bun --hot` reference (`gateway/src/main.ts:49-79` refuses hot reload outright).

**Out:**

- Rate limiting or auth at the proxy. Owner decision: this is an edge on a home network. Recorded as accepted risk in §5.
- Obtaining a real certificate — prod already has one via acme.sh.
- Automating nginx reload on acme.sh renewal. Flag the one-liner (`docker kill -s HUP sentient-inbound-proxy`) in the deploy README; automate on demonstrated need.
- Any change to `ingress-proxy` or the addon network.
- Dockerizing the gateway — explicitly contrary to the native-stack migration.
- Hardening the static handler's traversal guard. `gateway/src/api/handlers/webui.ts:56` rejects only a literal `..`, weaker than `downloads.ts`'s resolved-path containment. Pre-existing, unchanged by this work, tracked separately.

---

## 5. Accepted risks

Recorded so they are decisions, not oversights.

| Risk | Why accepted |
|---|---|
| No rate limiting at the edge; `auth.ts` has no failure counter around Argon2 verify | Owner decision — home-network edge. Not a regression: `:8888` is LAN-open today, so `/auth/setup` and the PIN endpoint are already reachable from the LAN. The proxy neither adds nor removes that exposure. |
| First-admin takeover race on a fresh host (`/auth/setup` gates only on `isFirstRun()`) | Same reasoning. Pre-existing and unchanged. |
| Proxy dies with the gateway; no maintenance page | A door onto nothing serves no one (§2.2). |
| Loopback-from-container is Docker-Desktop-specific | Measured (§2.7), and carried as a comment beside the bind so a future Linux host fails legibly. |
| Rollback is not transactional across image and binary | `setup-prod.py` rolls back the binary symlink; addon images carry mutable `:local` tags. Pre-existing across all addons; the proxy does not make it worse. Extending the health gate to 443 (§4.9) is the mitigation that *does* land here. |
| Browser on a LAN phone has no mic in dev | §2.6 — documented workaround, no native-app impact. |

---

## 6. E2E matrix

All cases run against the **local dev stack**, through `https://localhost` unless stated. Prod verification stays observational — `docker compose ps`, `docker logs`, `curl` — per the standing rule.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `inbound-https` | 1280×900 | stack up via `bun run dev` | GET `https://localhost/` | web UI loads (cert warning accepted once) | proxy access log 200; gateway static-handler hit, not a 404 |
| `inbound-http-redirect` | 1280×900 | stack up | GET `http://localhost/` | 301 to `https://` | proxy log 301, no gateway hit |
| `inbound-ws` | 1280×900 | logged in as Ada | send a chat message through the proxied origin | reply streams; no reconnect loop | gateway WS open; no upgrade-failure WARN |
| `gateway-not-lan-reachable` | — | gateway bound loopback | connect to `<lan-ip>:8888` from another host | connection refused | nothing in the gateway log — the connection never arrives |
| `fresh-install-wizard` | 1280×900 | `bootstrap_complete=false`, no containers | `bun run dev`, then GET `https://localhost/` | wizard loads | infra-class apply logged **before** the bootstrap gate; `boot-reconcile.skipped` still logged for capability addons |
| `proxy-survives-save` | — | stack up, gateway under `--watch` | touch a gateway source file | `https://localhost/` stays up throughout | reconcile logs skip-unchanged for `inbound-proxy`; **no** recreate; `verifyIdentity` still runs |
| `webui-served-natively` | 1280×900 | prod-shaped install, no vite | GET `/` on the gateway directly | UI loads | static handler constructed with a real `distDir` at startup |
| `stack-up-from-cold` | — | containers down, images present | `bun run dev` | canonical URL + side door + diagnostic printed; stack reaches ready | preflight decisions logged; readiness waits on loopback health **and** 443 |
| `ui-edit-reaches-both-doors` | 1280×900 | stack up, both doors open | edit a webui source file | 5173 hot-reloads; 443 shows the same change after a reload | `vite build --watch` logs a rebuild; **no** gateway restart, **no** proxy recreate |
| `preflight-refuses-foreign-port` | — | a foreign process on 8888 | `bun run dev` | refuses, names the holder and one runnable fix | holder named via lsof; **never signalled** |
| `mobile-connects-443` | native | Android + iOS, default backend config | connect and send a message | connects on 443 through the proxy | gateway WS open; no `:8888` dial attempted |

`gateway-not-lan-reachable` is what proves the security claim; without it the bind change is untested. `fresh-install-wizard` and `proxy-survives-save` are the two failures the previous draft would have shipped.

---

## 7. Open questions for the implementation plan

1. **Dev cert dir vs prod cert dir as one config key.** The shape (`inbound_proxy.cert_dir` with fallback, vs. a two-key primary/fallback pair) is a plan-level call.
2. **How readiness detects `vite build --watch`'s first pass.** The 443 probe cannot run until `dist/` holds a complete bundle. Options: poll for `dist/index.html`, parse the watcher's stdout, or simply let the 443 probe's own retry budget absorb it. The last is simplest and needs no coupling to vite's output format.
3. **`readiness` timeout budgets** for the 443 probe, and what the launcher prints when the gateway is healthy but the proxy is not.
4. **Where `inbound-proxy`'s image and config live** in the tree, given it does not belong under `gateway/mcp/` (§2.8).
5. **Whether `stack:status` reads the orchestrator's status endpoint** or probes independently. Reading it is less code and exercises a real surface; probing works when the gateway is down, which is when status is most wanted.
