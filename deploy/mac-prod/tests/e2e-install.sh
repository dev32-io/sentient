#!/usr/bin/env bash
# Rootless end-to-end rehearsal of `setup-prod.py install`.
#
# WHY THIS IS COMMITTED
# --------------------
# The install/rollback FSM is the highest-risk code in the native migration: a
# defect here takes production down and strands it on a release that does not
# boot. The unit suite (test_setup_prod.py) drives that FSM through fakes, which
# is where the invariants are pinned — but it cannot catch an ORDERING defect
# between the real collaborators. It did not: the checksum gate originally ran
# AFTER the idempotency shortcut, so a corrupt tarball whose version matched the
# running one exited 0 and printed "live and healthy". This script found that.
# So it lives in the repo, runs on any dev box, and is re-run after any change
# to the installer.
#
#   bash deploy/mac-prod/tests/e2e-install.sh <workdir> [port] [edge-port]
#
# REAL here:
#   the actual release tarball + its .sha256, the actual launchd plist and its
#   OPERATOR substitution, a real filesystem, real `tar`, real symlink flips,
#   and TWO real HTTPS endpoints (gateway + edge), each verified against its
#   own real pinned CA — no verify=False anywhere. The edge endpoint's cert
#   deliberately does NOT name `localhost` (it mirrors the mini's real acme.sh
#   cert naming `sentient.dev32.io`), so this also rehearses the installer's
#   check_hostname=False against a genuine name mismatch, not a same-name
#   loopback cert that would pass even if that flag were wrong.
#
# STUBBED, each because it needs root:
#   launchctl        -> calls are recorded and asserted; the REAL launchctl
#                       contract is rehearsed by tests/test_launchd_live.py
#   chown            -> an unprivileged chown to root:wheel cannot succeed
#   install-venv.sh  -> minutes per run; exercised for real by
#                       `bash deploy/mac-prod/native/install-venv.sh` directly
#
# STILL UNVERIFIED until an operator's first real run — see "First real run" in
# deploy/mac-prod/README.md:
#   * `chown -R root:wheel` actually changing ownership under sudo
#   * the `system` launchd domain (this box can only reach `gui/<uid>`)
#   * `UserName` switching launchd to a DIFFERENT account than the caller
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="${1:?usage: e2e-install.sh <workdir> [port] [edge-port]}"
PORT="${2:-18901}"
EDGE_PORT="${3:-$((PORT + 1))}"
# Any release built by scripts/build-gateway.sh; the newest is the default.
TARBALL="$(ls -t "$REPO"/dist/gateway/*.tar.gz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] || { echo "FATAL: no release in $REPO/dist/gateway — run scripts/build-gateway.sh"; exit 1; }
VERSION="$(basename "$TARBALL" .tar.gz)"
# One version above the release under test, built by re-packing it: the rollback
# case needs a DISTINCT version that fails health.
BAD_VERSION="${VERSION%.*}.$(( ${VERSION##*.} + 1 ))"
export PYTHONUNBUFFERED=1

rm -rf "$WORK"; mkdir -p "$WORK"/{opt,home,launchd,bin,log,stage}
echo "repo=$REPO  release=$VERSION  rollback-probe=$BAD_VERSION  port=$PORT"

# --- root-only stubs ----------------------------------------------------------
cat > "$WORK/bin/launchctl" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/log/launchctl.log"
# \`print\` always fails => every kickstart takes the bootstrap branch. The real
# branch decision is rehearsed against the real launchctl in test_launchd_live.py.
case "\$1" in print) exit 1 ;; esac
exit 0
EOF
cat > "$WORK/bin/chown" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/log/chown.log"
exit 0
EOF
chmod +x "$WORK/bin/launchctl" "$WORK/bin/chown"

# --- a real HTTPS health endpoint, with a real pinned CA ----------------------
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=sentient" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1

cat > "$WORK/server.py" <<'PY'
import http.server, ssl, sys, pathlib
work, port = pathlib.Path(sys.argv[1]), int(sys.argv[2])


class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # A named release is unhealthy — which one is live is read from the
        # symlink the installer just flipped. Deliberately NOT a timer: a
        # time-boxed outage races the probe budget, and "unhealthy for 4s" made
        # a rollback case silently pass as a successful install.
        broken = work / "BROKEN"
        current = work / "opt" / "current"
        live = current.resolve().name if current.is_symlink() else ""
        healthy = not (broken.is_file() and broken.read_text().strip() == live)
        body = b'{"status":"ok"}' if healthy else b'{"status":"down"}'
        self.send_response(200 if healthy else 503)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(work / "cert.pem", work / "key.pem")
srv = http.server.HTTPServer(("127.0.0.1", port), Health)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY
python3 "$WORK/server.py" "$WORK" "$PORT" > "$WORK/log/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

URL="https://127.0.0.1:$PORT/api/v1/health"
# Refuse to run the cases until the endpoint really verifies against our anchor:
# a half-started server would make every health check "fail" for the wrong reason.
python3 - "$URL" "$WORK/cert.pem" <<'PY' || { echo "FATAL: health endpoint never came up"; cat "$WORK/log/server.log"; exit 1; }
import ssl, sys, time, urllib.request
url, ca = sys.argv[1], sys.argv[2]
ctx = ssl.create_default_context(cafile=ca)
for _ in range(40):
    try:
        with urllib.request.urlopen(url, timeout=2, context=ctx) as r:
            if r.status == 200:
                print("   readiness: endpoint verifies against the pinned CA, 200")
                sys.exit(0)
    except Exception:
        time.sleep(0.25)
sys.exit(1)
PY

# --- a second real HTTPS endpoint, for the edge (443) probe -------------------
# Deliberately a DIFFERENT cert whose SAN does NOT include `localhost`: the
# mini's real inbound-proxy cert names `sentient.dev32.io`, not a loopback
# alias — which is exactly why the installer's edge probe dials with
# check_hostname=False. Reusing the gateway's own cert (which DOES carry
# `DNS:localhost`) would let a regression that re-enables the hostname check
# pass this harness by accident.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=sentient.dev32.io" \
  -addext "subjectAltName=DNS:sentient.dev32.io" \
  -keyout "$WORK/edge-key.pem" -out "$WORK/edge-cert.pem" >/dev/null 2>&1

cat > "$WORK/edge-server.py" <<'PY'
import http.server, ssl, sys, pathlib
work, port = pathlib.Path(sys.argv[1]), int(sys.argv[2])


class Edge(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Independent of which release is `current`: this simulates nginx, the
        # web bundle or the outward cert being broken while the gateway binary
        # itself is perfectly healthy — the exact fault the edge probe exists
        # to catch, and one an 8888-only gate would never see.
        down = work / "EDGE_DOWN"
        healthy = not down.is_file()
        body = b'{"status":"ok"}' if healthy else b'{"status":"down"}'
        self.send_response(200 if healthy else 502)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(work / "edge-cert.pem", work / "edge-key.pem")
srv = http.server.HTTPServer(("127.0.0.1", port), Edge)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY
python3 "$WORK/edge-server.py" "$WORK" "$EDGE_PORT" > "$WORK/log/edge-server.log" 2>&1 &
EDGE_SRV=$!
trap 'kill $SRV $EDGE_SRV 2>/dev/null' EXIT

EDGE_URL="https://localhost:$EDGE_PORT/"
# Same readiness discipline as the gateway endpoint, over the SAME
# check_hostname=False context the installer itself uses: a half-started
# server, OR a hostname check the installer forgot to disable, must fail here
# rather than surface as a mysterious case failure below.
python3 - "$EDGE_URL" "$WORK/edge-cert.pem" <<'PY' || { echo "FATAL: edge endpoint never came up"; cat "$WORK/log/edge-server.log"; exit 1; }
import ssl, sys, time, urllib.request
url, ca = sys.argv[1], sys.argv[2]
ctx = ssl.create_default_context(cafile=ca)
ctx.check_hostname = False
for _ in range(40):
    try:
        with urllib.request.urlopen(url, timeout=2, context=ctx) as r:
            if r.status == 200:
                print("   readiness: edge endpoint verifies against its pinned CA (name mismatch tolerated), 200")
                sys.exit(0)
    except Exception:
        time.sleep(0.25)
sys.exit(1)
PY

# --- a checkout shadow whose install-venv.sh is the stub ----------------------
SHADOW="$WORK/shadow"; mkdir -p "$SHADOW"
ln -s "$REPO/gateway" "$SHADOW/gateway"
ln -s "$REPO/capabilityServices" "$SHADOW/capabilityServices"
cp -R "$REPO/deploy" "$SHADOW/deploy"
cat > "$SHADOW/deploy/mac-prod/native/install-venv.sh" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/log/venv.log"
mkdir -p "\$2/bin" && ln -sf "\$(command -v python3)" "\$2/bin/python"
exit 0
EOF
chmod +x "$SHADOW/deploy/mac-prod/native/install-venv.sh"

run() {  # run <case-name> [installer args...]
  local name="$1"; shift
  local anchor="${ANCHOR:-$WORK/cert.pem}"
  local edge_anchor="${EDGE_ANCHOR:-$WORK/edge-cert.pem}"
  PATH="$WORK/bin:$PATH" SUDO_USER="$(id -un)" \
  python3 "$REPO/deploy/mac-prod/setup-prod.py" install "$@" \
    --repo "$SHADOW" --opt-root "$WORK/opt" --home "$WORK/home" \
    --launchd-dir "$WORK/launchd" --ca-bundle "$anchor" \
    --health-url "$URL" --wheels "$REPO/dist/wheels" --keep 2 \
    --health-attempts 6 --health-interval 1 \
    --outward-cert "$edge_anchor" --edge-url "$EDGE_URL" \
    --edge-attempts 6 --edge-interval 1 \
    > "$WORK/log/$name.out" 2>&1
  echo "EXIT=$?"
}
plain() { sed 's/\x1b\[[0-9;]*m//g' "$WORK/log/$1.out"; }
cur() { basename "$(readlink "$WORK/opt/current" 2>/dev/null || echo NONE)"; }

echo "=== CASE 1: fresh install ==="
run c1 "$TARBALL"; plain c1
echo "current=$(cur)"
echo "plist OPERATOR left=$(grep -c OPERATOR "$WORK/launchd/io.sentient.gateway.plist")  mode=$(stat -f %Sp "$WORK/launchd/io.sentient.gateway.plist")"
echo "launchctl: $(tr '\n' '|' < "$WORK/log/launchctl.log")"
echo "release chowned: $(grep -c "root:wheel.*opt/$VERSION\$" "$WORK/log/chown.log")"
echo "secrets mode=$(stat -f %Sp "$WORK/home/.sentient/secrets")"

echo; echo "=== CASE 2: reinstall the same healthy version (idempotent no-op) ==="
: > "$WORK/log/launchctl.log"
run c2 "$TARBALL"; plain c2
echo "launchctl calls=[$(tr '\n' '|' < "$WORK/log/launchctl.log")]  current=$(cur)"

echo; echo "=== CASE 3: operator config is never clobbered ==="
echo "orchestrator: {model: operator-tuned}" > "$WORK/home/.sentient/gateway/config/config.yaml"
run c3 "$TARBALL" > /dev/null
echo "config now: $(cat "$WORK/home/.sentient/gateway/config/config.yaml")"

echo; echo "=== CASE 4: bad checksum refuses, even matching the running version ==="
cp "$TARBALL" "$WORK/$VERSION-bad.tar.gz"
printf '%064d  x\n' 0 > "$WORK/$VERSION-bad.tar.gz.sha256"
: > "$WORK/log/launchctl.log"
run c4 "$WORK/$VERSION-bad.tar.gz"; plain c4 | tail -2
echo "current=$(cur)  launchctl=[$(tr '\n' '|' < "$WORK/log/launchctl.log")]"

echo; echo "=== CASE 5: health failure rolls back to the previous version ==="
tar -xzf "$TARBALL" -C "$WORK/stage" && mv "$WORK/stage/$VERSION" "$WORK/stage/$BAD_VERSION"
COPYFILE_DISABLE=1 tar -czf "$WORK/$BAD_VERSION.tar.gz" -C "$WORK/stage" "$BAD_VERSION"
shasum -a 256 "$WORK/$BAD_VERSION.tar.gz" > "$WORK/$BAD_VERSION.tar.gz.sha256"
echo "$BAD_VERSION" > "$WORK/BROKEN"   # only the new release fails health
: > "$WORK/log/launchctl.log"
run c5 "$WORK/$BAD_VERSION.tar.gz"; plain c5 | tail -3
rm -f "$WORK/BROKEN"
echo "current after rollback=$(cur)"
echo "launchctl: $(tr '\n' '|' < "$WORK/log/launchctl.log")"
echo "health of the live version now: $(python3 -c "
import ssl,urllib.request
c=ssl.create_default_context(cafile='$WORK/cert.pem')
print(urllib.request.urlopen('$URL',timeout=3,context=c).status)")"

echo; echo "=== CASE 6: pruning keeps current + the rollback target ==="
ls "$WORK/opt" | grep -v current | tr '\n' ' '; echo

echo; echo "=== CASE 7: the anchor the gateway has not minted yet ==="
# The fresh-host race: on a genuinely new mini ~/.sentient/gateway/certs/cert.pem does
# not exist until the gateway the installer just started mints it. The probe must
# WAIT for it, not abort the install. Before this was fixed, the missing-anchor
# error escaped install() past the rollback and left `current` on the new,
# unverified release.
rm -rf "$WORK/opt" "$WORK/late"; mkdir -p "$WORK/opt" "$WORK/late"
( sleep 3; cp "$WORK/cert.pem" "$WORK/late/cert.pem" ) &
: > "$WORK/log/launchctl.log"
ANCHOR="$WORK/late/cert.pem" run c7 "$TARBALL"; plain c7 | tail -2
echo "current=$(cur)  (expected $VERSION, installed while waiting for the anchor)"

echo; echo "=== CASE 8: edge (443) down while the gateway (8888) stays healthy ==="
# The fault this whole task exists to catch: the binary is fine — nginx (or the
# web bundle, or the outward cert) is not. Reuses the BAD_VERSION tarball built
# for case 5; unlike case 5, its GATEWAY health is left healthy this time and
# only the edge endpoint is downed, independently of which release is current
# — so both the failed install AND the rollback's re-verify hit the same
# broken edge, and the failure must say so both times rather than reporting a
# generic "not healthy".
touch "$WORK/EDGE_DOWN"
: > "$WORK/log/launchctl.log"
run c8 "$WORK/$BAD_VERSION.tar.gz"; plain c8 | tail -6
rm -f "$WORK/EDGE_DOWN"
echo "current after failed edge (rollback still flips the symlink even though its re-check also fails)=$(cur)  (expected $VERSION)"
echo "launchctl: $(tr '\n' '|' < "$WORK/log/launchctl.log")"
echo "distinguishing message present (install + rollback re-check = 2): $(grep -c 'gateway healthy, edge not' "$WORK/log/c8.out")"
echo "generic 'gateway not healthy' wrongly claimed: $(grep -c 'gateway not healthy —' "$WORK/log/c8.out")  (expected 0 — gateway was fine the whole time)"

echo; echo "=== END ==="
