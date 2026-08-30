# Egress proxy for managed addons

This directory preserves the tinyproxy source configuration. At runtime the
gateway seeds the active copies under:

```text
~/.sentient/gateway/config/egress-proxy/
```

and manages the `sentient-egress-proxy` container directly. It is not a compose
runtime service. The active templates live in
`gateway/templates/services/egress-proxy.*`; keep intentional source changes
aligned with those templates.

## What uses it

The proxy is the only public-network exit for containers on the internal addon
network. Today that includes:

- `sentient-outbound-worker` for first-class web fetching; and
- `sentient-searxng` for search-engine requests.

Hermes is a one-shot host executable, not a managed container, and does not use
this proxy as its runtime boundary.

## Policy

Browsing reaches unpredictable sites, so tinyproxy is deliberately
**open by default** for HTTP/HTTPS and applies a hostname denylist from
`filter.txt`. The proxy provides:

1. a central place to block known-malicious hosts;
2. outbound request logging for operational diagnosis; and
3. a network chokepoint that keeps internal-only addons from obtaining direct
   public egress.

It is not the primary defense against prompt injection or unsafe tool calls.
Those controls live at the gateway's content-scanning, authorization, and tool
mediation boundaries.

## Matching rules

The shipped settings use hostname matching (`FilterURLs Off`,
`FilterExtended Off`, `FilterDefaultDeny No`):

- one hostname or suffix pattern per line in `filter.txt`;
- no regular expressions or globs;
- comments start with `#`; and
- matching applies to plain HTTP and HTTPS `CONNECT` requests.

Validate tinyproxy's exact suffix behavior before relying on a broad parent
entry; list security-critical hostnames explicitly.

The repository denylist is intentionally small. Candidate external sources
include StevenBlack hosts and URLhaus, but importing or refreshing a third-party
list is an operator policy decision, not an automated repository behavior.

## DNS caveat

**tinyproxy does not filter DNS.** A filtered resolver or network DNS sinkhole
is still required if DNS exfiltration is in scope. Docker's resolver path must
ultimately use that filtered upstream; adding DNS settings to a retired compose
service does nothing to gateway-created containers.

## Apply and inspect changes

Edit the active files on the host, not just this source directory:

```text
~/.sentient/gateway/config/egress-proxy/tinyproxy.conf
~/.sentient/gateway/config/egress-proxy/filter.txt
```

Then restart the managed container:

```bash
docker restart sentient-egress-proxy
docker logs sentient-egress-proxy
```

The gateway's health watchdog continues to own reconciliation. The proxy has no
host-published port, so tests must run from a container on the managed addon
networks or through the supported web-search/fetch path; old
`docker exec hermes-alice ...` examples no longer apply.

Repository-owned addon images are baked with
`deploy/mac-prod/docker-compose.yml`, but the egress proxy uses the configured
public `kalaksi/tinyproxy` image and is pulled/created by the gateway
orchestrator.
