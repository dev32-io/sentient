#!/usr/bin/env bash
# The whole local stack, one command.
#
# WHY THIS EXISTS. A working dev stack used to need four remembered steps in a
# fixed order — source env.sh, stage SENTIENT_CODE, bake images, bun run dev —
# and missing any of them produced a stack that LOOKED healthy while whole
# subsystems went unexercised. This script owns that order so nobody has to
# rediscover it.
#
# WHY BASH AND NOT A BUN SCRIPT. It sources scripts/env.sh itself, which is what
# puts bun on PATH in the first place. A bun entry point could not bootstrap its
# own runtime.
#
# AUTO vs REFUSE is the one judgement call here. Auto-fix what is cheap,
# idempotent and unambiguous. Refuse — with the exact command — where the fix
# needs the network, holds secrets, or would mean signalling a process we cannot
# prove is ours. That last rule is the native-addon rule (config.yaml, see
# native_port_settle_timeout_ms) applied to the gateway itself.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/env.sh
source scripts/env.sh

CONFIG="${GATEWAY_CONFIG_PATH:-$REPO_ROOT/gateway/config.yaml}"

# ── constants ───────────────────────────────────────────────────────────────

RUN_DIR="$HOME/.sentient/run"
# ~/.sentient/run/<svc>.pid — written by gateway/src/system-orchestrator/native-driver.ts.
NATIVE_ADDON_SERVICES=(whisper-stt local-tts)
# STACK_RUN_DIR is deliberately its OWN subdirectory, not $RUN_DIR directly.
# native-io.ts#readPidFiles does an unfiltered readdir($RUN_DIR) and treats
# every *.pid entry as a native-addon record; reapOrphans() then SIGTERMs
# whatever pid each one names, on every boot, with no check that the name is a
# service the driver actually knows. A gateway.pid dropped straight into
# $RUN_DIR is therefore read back by the gateway THIS SCRIPT JUST SPAWNED and
# killed as a "boot orphan" — verified live: the gateway suicided within
# ~0.5s of every boot until this was moved one level down. A subdirectory
# name never matches the `.pid` suffix, so readdir skips it entirely.
STACK_RUN_DIR="$RUN_DIR/stack"
GATEWAY_PID_FILE="$STACK_RUN_DIR/gateway.pid"
VITE_PID_FILE="$STACK_RUN_DIR/vite.pid"

INBOUND_HTTP_PORT=80      # inbound-proxy: redirect-only (nginx.conf :8080 -> 301 https)
INBOUND_HTTPS_PORT=443    # inbound-proxy: the real door (nginx.conf :8443)
GATEWAY_PORT=8888         # native gateway, loopback-only (config.yaml#host)
VITE_PORT=5173            # webui dev server / HMR

CANONICAL_URL="https://localhost/"                  # the one URL a person opens
VITE_URL="http://localhost:${VITE_PORT}"            # hot reload, what you develop against
DIRECT_URL="https://localhost:${GATEWAY_PORT}"      # gateway, bypassing the door — diagnostics only

# docker-driver.ts#LABEL_MANAGED — every addon container the orchestrator creates.
SENTIENT_MANAGED_FILTER="label=sentient.managed=true"

# Build-only image tags deploy/mac-prod/docker-compose.yml bakes locally. Every
# other managed_services entry in config.yaml (searxng, ha-mcp, egress-proxy)
# pulls a public tag instead, and the orchestrator's own prepare() step pulls
# those itself — nothing for preflight to bake.
BUILD_ONLY_IMAGES=(inbound-proxy ingress-proxy fetch-mcp searxng-mcp ma-mcp)

GATEWAY_STOP_POLL_S=0.25       # graceful-shutdown poll interval before SIGKILL
GATEWAY_STOP_MAX_ATTEMPTS=20   # ~5s grace period (poll * attempts)
DOCKER_POLL_S=1                # docker-daemon wait poll interval
PROBE_MAX_TIME_S=3             # readiness probe timeout (gateway/door)
VITE_PROBE_MAX_TIME_S=2        # status probe timeout (vite, cheap/local)

# Read one scalar out of the stack: block, scoped to that block only. A
# top-level YAML key starts at column 0; entering `stack:` arms the match,
# hitting the NEXT column-0 key (any line not starting with space or `#`)
# disarms it again. Without that scoping this would match the first "  key:"
# anywhere in the file, so a same-named key added under some other top-level
# block later would silently shadow this one with no error. Defaults mirror
# shared/config's schema so a config predating this block still launches.
cfg() { # cfg <key> <default>
  awk -v k="  $1:" '
    /^stack:/ { in_block=1; next }
    /^[^ #]/  { in_block=0 }
    in_block && $0 ~ "^"k { print $2; exit }
  ' "$CONFIG" 2>/dev/null | tr -d '"' | grep -E '^[0-9]+$' || echo "$2"
}
READY_TIMEOUT_MS="$(cfg readiness_timeout_ms 60000)"
READY_POLL_MS="$(cfg readiness_poll_ms 500)"
DOCKER_WAIT_S="$(cfg docker_wait_s 30)"

die() { printf '\n  ✗ %s\n\n    fix:  %s\n\n' "$1" "$2" >&2; exit 1; }
step() { printf '  · %s\n' "$1"; }

# Kill a pid THIS SCRIPT recorded, and BLOCK until it is actually gone —
# poll, then escalate to SIGKILL, same shape everywhere. Returns 1 if it
# survived even SIGKILL. Shared by preflight_port's own-process reclaim and
# cmd_down: a caller that removes its pid-file ownership record before this
# returns 0 is how a still-live pid gets reported as "a process we did not
# start" by the very next preflight_port call — the record is the only proof
# of ownership, and dropping it early throws that proof away while the
# process it names might still be running.
kill_and_wait() { # kill_and_wait <pid>
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 "$GATEWAY_STOP_MAX_ATTEMPTS"); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep "$GATEWAY_STOP_POLL_S"
  done
  kill -9 "$pid" 2>/dev/null || true
  sleep "$GATEWAY_STOP_POLL_S"
  ! kill -0 "$pid" 2>/dev/null
}

# ── preflight ───────────────────────────────────────────────────────────────

preflight_docker() {
  local waited=0
  while ! docker info >/dev/null 2>&1; do
    if [ "$waited" -ge "$DOCKER_WAIT_S" ]; then
      # Docker is a HARD requirement: no daemon means no MCP tools, no searxng,
      # no egress-proxy and now no door. A stack that "starts" without it is a
      # lie that hides orchestrator bugs.
      die "docker daemon not reachable after ${DOCKER_WAIT_S}s" "open -a Docker"
    fi
    [ "$waited" -eq 0 ] && step "waiting for the docker daemon…"
    sleep "$DOCKER_POLL_S"; waited=$((waited + DOCKER_POLL_S))
  done
  step "docker daemon up"
}

preflight_config() {
  # $CONFIG mirrors the gateway's own default resolution
  # (config/startup-config.ts: GATEWAY_CONFIG_PATH ?? gatewayRoot/config.yaml),
  # so in the default (unset override) case this is the tracked repo file.
  [ -f "$CONFIG" ] || die "no gateway config at $CONFIG" \
    "git checkout -- gateway/config.yaml   # tracked in git; restore it if missing"
}

preflight_native_code() {
  local py="$SENTIENT_CODE/whisper-stt/venv/bin/python"
  # REFUSE, not auto-fix: creating the venvs needs the network and several
  # minutes, and doing it silently inside a launch would look like a hang.
  [ -x "$py" ] || die "SENTIENT_CODE is not staged ($SENTIENT_CODE)" "scripts/dev-stage-code.sh"
}

# Free the port, but only if we can PROVE the holder is ours. Signalling a
# process we cannot identify is not a decision an unattended launcher gets to
# take — the same rule the orchestrator applies to native addons.
preflight_port() { # preflight_port <port> <label> <pid_file|"">
  local port="$1" label="$2" pid_file="$3" pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && return 0

  # 80/443 belong to the inbound-proxy CONTAINER, not a process this script
  # spawns (pid_file is "" for both, see the cmd_up call sites). The
  # orchestrator owns that container's lifecycle (create-if-absent,
  # skip-recreate-when-unchanged-and-running — docker-driver.ts, so `bun --watch`
  # restarts don't drop the door) and re-proves ownership itself on every
  # gateway boot; a sentient-managed container already publishing this port on
  # the daemon IS that proof, the same way a successful container (re)start is
  # docker-driver.ts's own identity proof for infra services.
  if [ "$port" = "$INBOUND_HTTP_PORT" ] || [ "$port" = "$INBOUND_HTTPS_PORT" ]; then
    [ -n "$(docker ps -q --filter "$SENTIENT_MANAGED_FILTER" --filter "publish=$port")" ] && return 0
  elif [ -n "$pid_file" ] && [ -f "$pid_file" ]; then
    local ours; ours="$(cat "$pid_file")"
    if printf '%s\n' "$pids" | grep -qx "$ours"; then
      step "stopping our previous $label (pid $ours) on $port"
      kill_and_wait "$ours" || die "our previous $label (pid $ours) would not stop on $port" \
          "kill -9 $ours    # then re-run"
      return 0
    fi
  fi

  local who; who="$(ps -o comm= -p "$(printf '%s' "$pids" | head -1)" 2>/dev/null || echo unknown)"
  die "port $port ($label) is held by a process we did not start: pid $(printf '%s' "$pids" | head -1) ($who)" \
      "lsof -nP -iTCP:$port -sTCP:LISTEN    # identify it, then stop it yourself"
}

preflight_images() {
  local missing=()
  for img in "${BUILD_ONLY_IMAGES[@]}"; do
    docker image inspect "sentient/$img:local" >/dev/null 2>&1 || missing+=("$img")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    step "baking missing images: ${missing[*]}"
    docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build "${missing[@]}"
  fi
}

build_webui() {
  # ALWAYS, and BEFORE the gateway starts. This is the bundle 443 serves, so it
  # must be complete before anything probes that port. There is deliberately no
  # watcher: 5173 is what you develop against, and a relaunch is what refreshes
  # 443.
  step "building the web UI (this is what :443 serves)"
  bun run --filter './gateway/webui' build >/dev/null
}

# ── readiness ───────────────────────────────────────────────────────────────

# -k is deliberate and scoped: this is a LIVENESS probe against loopback in dev,
# where the outward cert is self-signed by design, and it decides only whether to
# keep waiting. It is NOT the pattern for anything that makes a trust decision —
# setup-prod.py's install gate pins the cert as a trust anchor, and nginx keeps
# proxy_ssl_verify on for the upstream hop. Do not copy this line into either.
probe() { # probe <url>; 0 when it answers
  curl -skf -o /dev/null --max-time "$PROBE_MAX_TIME_S" "$1" 2>/dev/null
}

wait_ready() {
  local deadline=$(( $(date +%s) * 1000 + READY_TIMEOUT_MS ))
  local gw=1 edge=1
  while [ "$(( $(date +%s) * 1000 ))" -lt "$deadline" ]; do
    probe "$DIRECT_URL/api/v1/health" && gw=0
    [ "$gw" -eq 0 ] && probe "$CANONICAL_URL" && edge=0
    [ "$gw" -eq 0 ] && [ "$edge" -eq 0 ] && return 0
    sleep "$(awk "BEGIN{print $READY_POLL_MS/1000}")"
  done
  if [ "$gw" -eq 0 ]; then
    # The most confusing failure to debug blind, so name it precisely.
    die "gateway is healthy on $DIRECT_URL but the door at $CANONICAL_URL is not answering" \
        "docker logs sentient-inbound-proxy"
  fi
  die "gateway did not become healthy within $((READY_TIMEOUT_MS / 1000))s" \
      "tail -n 50 ~/.sentient/gateway/logs/\$(date +%F).log"
}

# ── commands ────────────────────────────────────────────────────────────────

cmd_up() {
  printf '\n  sentient — starting the stack\n\n'
  preflight_config
  preflight_docker
  preflight_native_code
  preflight_port "$INBOUND_HTTP_PORT" http ""
  preflight_port "$INBOUND_HTTPS_PORT" https ""
  preflight_port "$GATEWAY_PORT" gateway "$GATEWAY_PID_FILE"
  preflight_port "$VITE_PORT" vite "$VITE_PID_FILE"
  preflight_images
  build_webui

  mkdir -p "$STACK_RUN_DIR"
  # Kill the whole process group on exit so Ctrl-C takes vite with the gateway.
  # Native addons deliberately survive — launchd does not reap them either, and
  # the next boot's port-settle reclaims them. `stack.sh down` is the full stop.
  trap 'kill 0' EXIT

  ( cd gateway && exec bun --watch src/main.ts ) &
  echo $! > "$GATEWAY_PID_FILE"
  ( exec bun run --filter './gateway/webui' dev ) &
  echo $! > "$VITE_PID_FILE"

  wait_ready
  printf '\n  ✓ ready\n\n      open        %s\n      hot reload  %s\n      gateway     %s  (diagnostics)\n\n' \
    "$CANONICAL_URL" "$VITE_URL" "$DIRECT_URL"
  wait
}

cmd_down() {
  printf '\n  sentient — stopping the stack\n\n'
  # Gateway AND vite: a live `up` in another terminal is blocked on its own
  # `wait` for BOTH background jobs, so stopping only the gateway here leaves
  # vite running and that other terminal's script hanging forever, never
  # reaching its own EXIT trap. Stopping both is what makes `down` the full
  # stop the comment in cmd_up promises, not just Ctrl-C's subset.
  #
  # The pid file is dropped ONLY after kill_and_wait confirms the process is
  # actually gone — same reasoning native-driver.ts's own reapOrphans applies
  # to native addons (keep the record if the pid survives, drop it once it's
  # confirmed dead). Removing it earlier is how the immediately-following
  # `bun run dev` finds the port still held with no record to explain it, and
  # reports the gateway this command just stopped as "a process we did not
  # start".
  for entry in "gateway:$GATEWAY_PID_FILE" "vite:$VITE_PID_FILE"; do
    local label="${entry%%:*}" f="${entry#*:}"
    [ -f "$f" ] || continue
    local pid; pid="$(cat "$f")"
    if kill_and_wait "$pid"; then
      step "$label stopped (pid $pid)"
      rm -f "$f"
    else
      step "$label (pid $pid) would not stop — pid file kept so the next preflight can retry"
    fi
  done
  # Native addons are NOT reaped by the gateway's shutdown hook, so without this
  # they outlive it holding 8769/8771 and the next launch pays the port-settle
  # timeout per addon reclaiming its own orphan.
  for svc in "${NATIVE_ADDON_SERVICES[@]}"; do
    local f="$RUN_DIR/$svc.pid"
    [ -f "$f" ] || continue
    if kill_and_wait "$(cat "$f")"; then
      step "$svc stopped"
      rm -f "$f"
    else
      step "$svc would not stop — pid file kept so the next preflight can retry"
    fi
  done
  # Docker is best-effort here, not a hard requirement like cmd_up's preflight:
  # the gateway/vite/native cleanup above already ran, and someone cleaning up
  # a broken stack is exactly who is likely to hit a dead daemon. Abort under
  # `set -e` would report a raw docker error and skip nothing that mattered.
  if docker info >/dev/null 2>&1; then
    docker ps -q --filter "$SENTIENT_MANAGED_FILTER" | xargs -r docker stop >/dev/null
    step "docker addons stopped"
  else
    step "docker unreachable — could not stop docker addons (they may still be running)"
  fi
  printf '\n'
}

cmd_status() {
  # Probes independently rather than reading the orchestrator's status endpoint:
  # status is most wanted when the gateway is DOWN, which is exactly when that
  # endpoint cannot answer. Every check below is a real if/else, not
  # `A && B || C` — that shape runs C too when B fails (shellcheck SC2015),
  # which for `step` (a `printf`) is unlikely to fail but would otherwise let
  # this print a service as both ready and DOWN in the same breath.
  printf '\n  sentient — stack status\n\n'

  local docker_up=1
  if docker info >/dev/null 2>&1; then
    docker_up=0
    step "docker      up"
  else
    step "docker      DOWN"
  fi

  if probe "$DIRECT_URL/api/v1/health"; then
    step "gateway     ready   $DIRECT_URL"
  else
    step "gateway     DOWN"
  fi

  if probe "$CANONICAL_URL"; then
    step "door        ready   $CANONICAL_URL"
  else
    step "door        DOWN"
  fi

  if curl -sf -o /dev/null --max-time "$VITE_PROBE_MAX_TIME_S" "$VITE_URL"; then
    step "vite        ready   $VITE_URL"
  else
    step "vite        DOWN"
  fi

  printf '\n'
  # Guarded the same way as the daemon check above: with docker unreachable
  # there is nothing valid to list, and this must report that, not crash.
  if [ "$docker_up" -eq 0 ]; then
    docker ps --filter "$SENTIENT_MANAGED_FILTER" --format '    {{.Names}}  {{.Status}}'
  fi
  printf '\n'
}

case "${1:-up}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  *) die "unknown command: $1" "scripts/stack.sh {up|down|status}" ;;
esac
