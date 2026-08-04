# Inbound Proxy and Web Serving — Design

**Date:** 2026-08-04
**Branch context:** written on `feature/native-orchestrator`; independent of the session-model wave.
**Status:** design approved in discussion, not yet planned or implemented.

**Goal:** one outward-facing door for the whole stack, identical in dev and prod, so `https://<host>` reaches the web UI — and so the web UI is actually served at all.

---

## 1. What we have today

Three separate facts, established by inspection rather than assumption. Two of them are defects.

### 1.1 The gateway serves the API, on one port, everywhere

`gateway/config.yaml:12` sets `port: 8888`. That value is the same in dev and in prod — there is no per-environment port. The gateway binds it on **all interfaces**, so today it is reachable from the LAN with no policy in front of it.

TLS is already terminated by the gateway itself: it mints a self-signed CA into `~/.sentient/gateway/certs/`, producing `cert.pem` (0644), `key.pem` (0600), and `san.txt`. The directory comes from `GATEWAY_CERTS_DIR`, which `deploy/mac-prod/io.sentient.gateway.plist:67` sets explicitly to that path, falling back to `gatewayStateDir("certs")`. `shared/tls/src/tls.ts:48-49` fixes the two filenames; `ensureTlsMaterial()` mints them if absent. `setup-prod.py` pins its post-install health probe to that same `cert.pem` as a trust anchor (`CERT_RELATIVE = "gateway/certs/cert.pem"`).

**This is the cert path the inbound proxy will reuse.** It is already the source of truth for the stack's identity, it already survives upgrades (it lives in `~/.sentient`, not in the code tree), and reusing it means the proxy and the gateway present the same identity rather than two competing self-signed certs.

### 1.2 The web UI is served nowhere — this is the real hole

`gateway/src/server.ts:152` builds the static handler from `services.webDistDir`. That value is `process.env.WEB_DIST_DIR` (`gateway/src/config/startup-config.ts:176`), and **`WEB_DIST_DIR` is set nowhere in the repository** — not in the plist, not in `scripts/env.sh`, not in any compose file. `createWebuiHandler` therefore returns null, and the gateway serves the API with no UI attached.

In dev this is invisible: vite owns the UI on `http://localhost:5173` (`strictPort: true`) and proxies `/api/v1` and `/api/v1/ws` to the gateway, so the UI works and `https://localhost:8888/` legitimately 404s. In prod there is no vite, so **there is no UI on any port**. `gateway/webui/vite.config.ts:11` builds to `dist`, so the artifact exists; nothing points at it.

This is a prerequisite, not a side quest. Standing up 443 in front of a gateway that serves no UI produces the same 404 over a nicer URL.

### 1.3 Addons are already loopback-only

`deploy/mac-prod/docker-compose.yml:21` states the rule and the services follow it: every addon host port is published as `127.0.0.1:<port>:<port>`. Nothing in the addon tier is LAN-facing today.

So the outward-facing surface of the entire stack is **one port: the gateway's 8888**. The inbound proxy has exactly one upstream, not a fleet.

### 1.4 `ingress-proxy` is a different thing, and the name is already taken

`gateway/mcp/ingress-proxy/` is a stock `nginx:1.30-alpine` with a single `COPY`d config and `RUN nginx -t` at build time. It exists so MCP containers can stay on an `internal: true` network while still being reachable — it spans the **internal addon network boundary**. It is not, and must not become, the public entrance.

It is also the encapsulation precedent this design follows: a stock upstream image, one declarative config file, no code of ours, and a build that fails on a malformed config.

---

## 2. The design

One container owns every outward-facing port. Everything else binds loopback.

```
LAN ──▶ inbound-proxy  :443   (+ :80 → 301 redirect)
           │
           └─ proxy_pass ──▶ host loopback :8888 ──▶ gateway
                                                      ├── webui static (WEB_DIST_DIR)
                                                      └── /api/v1, /api/v1/ws
gateway        binds 127.0.0.1 only            (today: all interfaces)
every addon    binds 127.0.0.1 already          (unchanged)
```

**Dev and prod run the identical topology.** That is the point of doing this in both places: a routing, header, or WebSocket-upgrade bug shows up on the dev Mac instead of only on the mini, and there is one thing to reason about rather than two. The only intended difference is that in dev, vite continues to serve the UI with hot reload, so the proxy's UI route points at vite while prod's points at the gateway's static handler.

### 2.1 Why a container, and what is actually privileged

Ports below 1024 require root on macOS. The only privileged act in this design is **binding 443**, and Docker's daemon — already running as root, already a hard dependency of the stack because the gateway's orchestrator drives it, already auto-started at login on the mini — performs that bind. Nothing we author runs as root.

This does **not** dockerize the gateway. The gateway remains a native compiled binary under `launchd`; that migration stands. The proxy is a separate, stateless container in front of it, holding no application logic.

`pf` port-forwarding was considered and rejected: rules are lost on reboot unless anchored, the anchor file is a second root-owned artifact to maintain, and it gives no place to terminate TLS or redirect `:80`.

### 2.2 The loopback question — settled by measurement

Binding the gateway to `127.0.0.1` only works if a container can still reach it. On native Linux it cannot: `host.docker.internal` arrives on the bridge interface, and a loopback-bound service refuses it.

Measured on this Mac (Docker Desktop), 2026-08-04:

| Case | Host bind | Result |
|---|---|---|
| A | `127.0.0.1:9911` (loopback only, confirmed via `lsof`) | container reached it ✅ |
| B — control | `0.0.0.0:9912` | container reached it ✅ |
| C — negative control | nothing listening on 9913 | `Connection refused` ✅ |

The negative control refusing proves the positive is not a false pass; `lsof` confirmed case A really was `127.0.0.1:9911` and not `*:9911`.

**Conclusion: the gateway can bind loopback-only and the proxy still reaches it, with no compromise.** The mechanism is visible in C's error — the container connects from `192.168.65.254`, Docker Desktop's host-side address, and its network stack proxies to host loopback. This is Docker-Desktop-specific and **would not work on native Linux**; that caveat belongs in a comment next to the bind, because someone will eventually try this on a Linux box.

### 2.3 TLS

The proxy reads `~/.sentient/gateway/certs/{cert,key}.pem` — the same material the gateway mints — mounted read-only. Consequences:

- **No new cert authority.** One identity for the stack, one thing to trust on client devices, one thing `setup-prod.py`'s health probe already pins.
- **Ordering:** the material only exists after the gateway has started once. The proxy must tolerate its absence at first boot rather than crash-looping — the same problem `setup-prod.py:598` already documents for the health probe ("a fresh host's `cert.pem` does not exist until the gateway has run"). Restart policy handles it; the proxy is stateless.
- `key.pem` is 0600 and owned by the operator. The mount must preserve that; the container reading it must not require loosening host permissions.
- Terminating TLS at the proxy means the proxy→gateway hop is the loopback interface on a single host. Whether that hop stays TLS or drops to plaintext is a decision for the plan (see §4).

A self-signed cert still warns in browsers. Replacing it with a real certificate for `sentient.dev32.io` is **separate, later, and out of scope here** — but this design is the precondition for it, because a single terminator is the only sane place to install one.

### 2.4 Naming

Called **`inbound-proxy`**, per owner decision.

Noted once, for the record: `ingress` and `inbound` are near-synonyms, and the stack will contain both `ingress-proxy` (internal addon-network boundary) and `inbound-proxy` (public host/LAN boundary). `edge-proxy` was proposed to avoid that collision. The owner chose `inbound-proxy`; the disambiguation therefore has to be carried by a header comment in each proxy's config stating which boundary it guards, the way `ingress-proxy`'s config already does.

---

## 3. Scope

**In:**
1. Set `WEB_DIST_DIR` so the gateway actually serves the built UI in prod.
2. Add the `inbound-proxy` container: 443 + 80-redirect, cert mounted from `~/.sentient/gateway/certs/`, upstream on host loopback.
3. Move the gateway's bind from all-interfaces to `127.0.0.1`.
4. Run the same topology in dev.

**Out:**
- A real (non-self-signed) certificate.
- Any change to `ingress-proxy` or the addon network.
- Dockerizing the gateway — explicitly contrary to the native-stack migration.
- Auth or rate limiting at the proxy. The gateway owns authorization; a second policy point that can drift from it is worse than none.

---

## 4. Open questions for the implementation plan

1. **Does the proxy→gateway hop stay TLS?** Terminating at the proxy and re-encrypting to the gateway is belt-and-braces on a loopback hop of one host; plaintext is simpler but means the gateway must accept non-TLS on 8888, which is a behavioural change to its listener. Either is defensible — it needs deciding, not defaulting.
2. **WebSocket upgrade headers.** `/api/v1/ws` must survive the hop; `ingress-proxy`'s existing config is the reference for what nginx needs here.
3. **Dev's vite route.** Whether the proxy fronts vite in dev (closest to prod, but interposes a proxy on the hot-reload socket) or dev keeps 5173 direct with the proxy only fronting the API. The first is more faithful; the second is less likely to fight HMR.
4. **First-boot ordering** between the proxy and the gateway that mints the cert (§2.3).
5. **Where `WEB_DIST_DIR` points in a compiled-binary install** — the built `dist` has to land somewhere `setup-prod.py` installs and the plist can name.

---

## 5. E2E matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `inbound-https` | 1280×900 | stack up, proxy running | GET `https://<host>/` | web UI loads (cert warning until §2.3's follow-up) | proxy access log 200; gateway static-handler hit |
| `inbound-http-redirect` | 1280×900 | stack up | GET `http://<host>/` | 301 to `https://` | proxy access log 301, no gateway hit |
| `inbound-ws` | 1280×900 | logged in as Ada | send a chat message through the proxied origin | reply streams; no reconnect loop | gateway WS open; no upgrade-failure WARN |
| `gateway-not-lan-reachable` | — | gateway bound loopback | connect to `<lan-ip>:8888` from another host | connection refused | nothing in gateway log — the connection never arrives |
| `webui-served-natively` | 1280×900 | prod-shaped install, no vite | GET `/` on the gateway directly | UI loads (proves `WEB_DIST_DIR` is wired) | static handler constructed at startup, not null |
| `cert-absent-first-boot` | — | `~/.sentient/gateway/certs/` empty | start proxy before gateway | proxy retries, does not crash-loop | restart backoff, then a clean bind after the gateway mints |

`gateway-not-lan-reachable` is the one that proves the security claim; without it the bind change is untested. `cert-absent-first-boot` is the ordering hazard from §2.3.

All cases run against the **local dev stack**. Prod verification stays observational — `docker compose ps`, `docker logs`, `curl` — per the standing rule.
