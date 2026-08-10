# Egress Proxy for Hermes Containers

This directory defines the tinyproxy instance that sits between each Hermes
agent container and the outside world. Read this before changing
`tinyproxy.conf` or `filter.txt` — the threat model is subtler than
"allowlist everything we trust."

## What this proxy is for

Hermes agents browse the web. The `sentient-searxng-mcp` container exposes
`search_web` (query SearXNG) and the `sentient-fetch-mcp` container exposes
`fetch` (open any URL and return parsed text). A browsing agent by nature
reaches out to unpredictable sites, so the proxy is deliberately
**open-by-default** for HTTPS with a **denylist** for known-bad hosts.

The proxy exists to provide:

1. **A place to block known-bad hosts** when an incident, report, or OSS
   blocklist (StevenBlack, URLhaus, Spamhaus) identifies them.
2. **Outbound traffic logging** for forensics / audit.
3. **A central network chokepoint** if policy ever tightens — it's much
   easier to tune one config than to rewrite container networking later.

It is **not** the primary defense against:

- **Prompt injection.** Handled by the gateway's injection scanner
  (`gateway/src/security/injection-scanner.*`).
- **Risky tool invocations.** Handled at the MCP tool boundary by the role
  gate (`canExecute(role, tier)`, `shared/protocol/src/roles.ts`) and each
  person's per-tool permission — `allow` / `ask` / `deny` / `off`, resolved
  in `gateway/src/tools/`. A `confirm`-tier tool an `ask` resolves to is a
  real permission prompt, never auto-approved.
- **Runaway agents.** Handled by the session risk accumulator.
- **Data exfiltration via DNS.** Handled upstream — see *DNS caveat* below.

If you find yourself adding allowlist entries here, stop and reconsider.
This file is a denylist.

## Why not an allowlist?

An allowlist works great for **fixed-endpoint agents** — SQL copilots, ops
bots, internal API callers. It is the wrong tool for a browsing agent:

- Every new site the user asks about becomes a proxy 403.
- Agents start preferring stale allowlisted sources over better ones they
  can't reach, silently degrading answer quality.
- Operators end up whack-a-moling the allowlist and giving up.

Production LLM-agent deployments (ChatGPT browsing, Claude computer use,
Perplexity, Brave Leo) all use some combination of:

- Open or lightly-filtered network egress.
- DNS-layer blocklists for known-malicious hosts.
- Reputation checks at fetch time (Google Safe Browsing, URLhaus).
- Strong content-side scanners on what the agent receives back.

We lean on the same pattern. The network layer is permissive by design; the
heavy lifting happens at the content layer.

## DNS caveat (important)

**This proxy does not filter DNS.** If a prompt-injection payload tricks an
agent into resolving `exfil.attacker.example`, the DNS query leaks even if
the HTTPS connect is later blocked by this proxy's denylist.

In Kevin's home deployment this is covered by a Pi-hole upstream of the
Docker host, which filters DNS for the entire LAN. **If you are deploying
Sentient elsewhere, you should either:**

- **Point Docker / Hermes containers at a filtered DNS** such as Quad9
  (`9.9.9.9`, `149.112.112.112`), NextDNS, or Cloudflare 1.1.1.1 for
  Families (`1.1.1.3`). One-liner in `docker-compose.yml`:
  ```yaml
  services:
    hermes-alice:
      dns: ["9.9.9.9", "149.112.112.112"]
  ```
- **Or run a DNS sinkhole** (Pi-hole, AdGuard Home, NextDNS self-host) at
  the network edge and point the Docker host's resolver at it.

Do not ship to untrusted users without one of these in place. The content
scanners help, but DNS exfiltration bypasses them entirely.

## Matching rules

Hostname-only matching (`FilterURLs Off`, `FilterExtended Off`):

- One hostname per line in `filter.txt`. Plain text, no regex, no glob.
- Matches both plain HTTP and HTTPS CONNECT.
- **Subdomains are not implied.** `example.com` in the filter does NOT
  block `www.example.com` — list each explicitly.
- Comments (lines starting with `#`) are ignored.

## Seeding the denylist

The repo ships with `filter.txt` empty. Two sensible starting points:

- **StevenBlack/hosts** — well-maintained hostname-based blocklist that
  covers ads, trackers, and known malware hosts:
  <https://github.com/StevenBlack/hosts>
- **URLhaus** — abuse.ch's active-malware host list:
  <https://urlhaus.abuse.ch/downloads/hostfile/>

Both publish host-per-line text files compatible with tinyproxy's filter
format after minor cleanup. A production deployment would sync one of these
on a timer (systemd unit, cron, or a sidecar) and restart tinyproxy.

## Ports

Hermes containers route both HTTP (port 80) and HTTPS (port 443) through
this proxy via the `HTTP_PROXY` / `HTTPS_PROXY` environment variables set
in each Hermes service in `deploy/docker/docker-compose.yml`. `CONNECT`
port 443 is whitelisted explicitly.

## Operating notes

- **Logs:** `docker logs sentient-egress-proxy`. Every denied request
  shows up with `Proxying refused` + hostname. Useful when diagnosing
  "why did this fetch fail?"
- **Reload after config change:** `docker compose restart egress-proxy`.
- **Tests:** exercise fetch manually with
  `docker exec hermes-alice curl -sS https://example.com/` — should
  succeed with the default denylist-only policy.
