#!/usr/bin/env bash
# Proves the two halves of the ingress-proxy design against the REAL docker
# daemon, because both are invisible to unit tests:
#
#   1. the native gateway can reach the confined MCPs through the proxy, and
#   2. those MCPs cannot egress at all with HTTP_PROXY/HTTPS_PROXY unset.
#
# (2) is the assertion the pre-ingress-proxy shape FAILED: joining fetch-mcp to
# sentient-external made it reachable and left it able to dial the open internet
# directly, which is the confused-deputy surface the design exists to close.
#
# Run from the repo root with the gateway NOT running (one owner per container
# set). Read-only against prod is not enough here — this MUTATES containers, so
# LOCAL DEV STACK ONLY, never mini0.lan / sentient.dev32.io.
set -uo pipefail

CONFIG_DIR="${HOST_CONFIG_DIR:-$HOME/.sentient/gateway/config}"
# Addons the ingress path is made of, in dependency order. searxng is included
# because searxng-mcp is useless without it.
ADDONS=(egress-proxy ingress-proxy searxng searxng-mcp fetch-mcp)
# Containers that published these ports BEFORE ingress-proxy took them over.
# Docker allows exactly one holder per host port, and the apply recreates these
# two anyway — releasing the ports first is the whole migration step for a host
# that ran the pre-ingress-proxy shape. Harmless on a host that never did.
STALE_PUBLISHERS=(sentient-fetch-mcp sentient-searxng-mcp)
# A literal IP, so a failure here means NO ROUTE and not merely "DNS is broken".
EGRESS_PROBE_IP=1.1.1.1
EGRESS_PROBE_PORT=443
PROBE_TIMEOUT_S=5
# One-second-apart attempts at the MCP handshake. 15 covers a cold container
# start on this box (~1s observed) with a wide margin.
MCP_HANDSHAKE_RETRIES=15
# Placeholder used to force an addon onto a new IP. Any tiny image that idles.
SQUATTER_IMAGE=alpine:latest
SQUATTER_TTL_S=300

fails=0
step() { printf '\n=== %s ===\n' "$1"; }
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

step "release the host ports ingress-proxy is taking over (one-time migration)"
for c in "${STALE_PUBLISHERS[@]}"; do
  if docker inspect "$c" --format '{{.HostConfig.PortBindings}}' 2>/dev/null | grep -q '127.0.0.1'; then
    printf 'removing %s — it still publishes a port the proxy now owns\n' "$c"
    docker rm -f "$c" >/dev/null
  fi
done

step "apply the shipped addon topology through the real orchestrator"
if HOST_CONFIG_DIR="$CONFIG_DIR" bun qa/native/apply-addons.ts "${ADDONS[@]}"; then
  pass "every required addon reached ready"
else
  fail "orchestrator apply did not reach ready for every required addon"
fi

step "fetch-mcp is attached to the no-egress network ONLY"
nets=$(docker inspect sentient-fetch-mcp --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr -s ' ')
printf 'networks: %s\n' "$nets"
if [ "$(echo "$nets" | tr ' ' '\n' | grep -c 'sentient-external')" = "0" ] &&
  echo "$nets" | grep -q 'sentient-internal'; then
  pass "sentient-internal only"
else
  fail "expected sentient-internal only, got: $nets"
fi

step "fetch-mcp publishes NO host port"
# `docker port` lists only real host mappings. NetworkSettings.Ports is the wrong
# field to assert on: it also carries the image's EXPOSE with an EMPTY binding
# list (`map[8088/tcp:[]]`), which reads like a publish and is not one.
published=$(docker port sentient-fetch-mcp)
bindings=$(docker inspect sentient-fetch-mcp --format '{{.HostConfig.PortBindings}}')
printf 'docker port: "%s"   PortBindings: %s\n' "$published" "$bindings"
if [ -z "$published" ] && [ "$bindings" = "map[]" ]; then
  pass "no host publish"
else
  fail "expected no publish, got: $published $bindings"
fi

step "THE POINT: fetch-mcp cannot egress with the proxy env unset"
# `curl` is NOT installed in this image (python:3.13-slim) — a curl-based probe
# exits 127 and false-passes any `|| echo "no route"` idiom. Use the interpreter
# that IS there, and check routing (literal IP) separately from DNS.
route_out=$(docker exec sentient-fetch-mcp env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  python3 -c "
import socket
try:
    socket.create_connection(('${EGRESS_PROBE_IP}', ${EGRESS_PROBE_PORT}), ${PROBE_TIMEOUT_S}).close()
    print('EGRESS-REACHED')
except Exception as e:
    print('EGRESS-BLOCKED', type(e).__name__)
" 2>&1)
printf 'route probe: %s\n' "$route_out"
if echo "$route_out" | grep -q 'EGRESS-BLOCKED'; then
  pass "no route to ${EGRESS_PROBE_IP}:${EGRESS_PROBE_PORT} — confinement is network-enforced"
else
  fail "fetch-mcp reached the open internet: $route_out"
fi

step "fetch-mcp still reaches the internet THROUGH egress-proxy"
proxied=$(docker exec sentient-fetch-mcp python3 -c "
import urllib.request
r = urllib.request.build_opener(urllib.request.ProxyHandler({'https': 'http://sentient-egress-proxy:3128'})).open('https://example.com', timeout=10)
print('PROXIED-OK', r.status)
" 2>&1 | tail -1)
printf 'proxied fetch: %s\n' "$proxied"
if echo "$proxied" | grep -q 'PROXIED-OK 200'; then
  pass "the one permitted path out still works"
else
  fail "egress-proxy path broken: $proxied"
fi

step "the gateway can reach both MCPs through the proxy (real MCP handshake)"
# Retried, deliberately. The MCPs now carry `noop` healthchecks (nothing on the
# host can probe them directly any more), so the orchestrator reports ready
# without waiting for them to bind — the same trade-off already documented for
# searxng. The gateway tolerates this because its MCP client dials lazily and
# retries; a QA probe firing once, immediately, does not.
mcp_initialize() {
  curl -sS -m 15 -X POST "http://127.0.0.1:$1/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"qa-probe","version":"0"}}}' \
    2>&1 | tr -d '\r' | grep '"serverInfo"' | head -1
}

for probe in "8088 fetch" "8087 searxng"; do
  # shellcheck disable=SC2086
  set -- $probe
  port=$1
  label=$2
  body=""
  for _ in $(seq 1 "$MCP_HANDSHAKE_RETRIES"); do
    body=$(mcp_initialize "$port")
    [ -n "$body" ] && break
    sleep 1
  done
  printf '%s (127.0.0.1:%s): %s\n' "$label" "$port" "${body:0:150}"
  if [ -n "$body" ]; then
    pass "${label}-mcp answered initialize through ingress-proxy"
  else
    fail "${label}-mcp did not answer through ingress-proxy on ${port}"
  fi
done

step "ingress-proxy is the ONLY container spanning both networks"
spanning=""
for c in $(docker ps --filter label=sentient.managed=true --format '{{.Names}}'); do
  n=$(docker inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')
  if echo "$n" | grep -q 'sentient-internal' && echo "$n" | grep -q 'sentient-external'; then
    spanning="$spanning $c"
  fi
done
printf 'spanning both:%s\n' "$spanning"
# egress-proxy legitimately spans too — it is the outbound half of the same
# pattern. ha-mcp/ma-mcp also span when deployed (LAN egress the proxy cannot
# tunnel); they are optional and absent on this box.
if echo "$spanning" | grep -q 'sentient-ingress-proxy'; then
  pass "ingress-proxy spans both, as designed"
else
  fail "ingress-proxy is not on both networks"
fi

step "the proxy follows an addon that MOVES (the reason for the runtime resolver)"
# nginx caches a literal upstream name for the process lifetime. The
# orchestrator recreates containers as its normal mode of operation, and a
# recreated container can come back on a different IP — so a proxy that resolved
# once at startup would go on dialling a dead address with no error until a tool
# call failed. Force the move rather than hoping for it: park a placeholder on
# the address fetch-mcp is about to vacate, so docker MUST hand it a new one.
squatter=ip-squatter-$$
cleanup_squatter() { docker rm -f "$squatter" >/dev/null 2>&1 || true; }
trap cleanup_squatter EXIT
proxy_started_before=$(docker inspect sentient-ingress-proxy --format '{{.State.StartedAt}}')
old_ip=$(docker inspect sentient-fetch-mcp --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
docker rm -f sentient-fetch-mcp >/dev/null
docker run -d --name "$squatter" --network sentient-internal "$SQUATTER_IMAGE" sleep "$SQUATTER_TTL_S" >/dev/null
HOST_CONFIG_DIR="$CONFIG_DIR" bun qa/native/apply-addons.ts fetch-mcp >/dev/null 2>&1
new_ip=$(docker inspect sentient-fetch-mcp --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
proxy_started_after=$(docker inspect sentient-ingress-proxy --format '{{.State.StartedAt}}')
printf 'fetch-mcp %s -> %s   (placeholder holds %s)\n' "$old_ip" "$new_ip" "$old_ip"
body=""
for _ in $(seq 1 "$MCP_HANDSHAKE_RETRIES"); do
  body=$(mcp_initialize 8088)
  [ -n "$body" ] && break
  sleep 1
done
cleanup_squatter
trap - EXIT
if [ "$old_ip" = "$new_ip" ]; then
  fail "inconclusive: fetch-mcp came back on the same IP, so nothing was proven"
elif [ "$proxy_started_before" != "$proxy_started_after" ]; then
  fail "inconclusive: ingress-proxy restarted, which would re-resolve anyway"
elif [ -n "$body" ]; then
  pass "reached the moved container through an unrestarted proxy"
else
  fail "proxy did not follow the move — upstream resolution is being cached"
fi

printf '\n===== %s =====\n' "$([ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$fails CHECK(S) FAILED")"
exit "$fails"
