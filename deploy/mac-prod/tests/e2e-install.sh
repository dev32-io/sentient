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
#   the actual release tarball + its .sha256, a disposable filesystem, real
#   `tar`/symlink operations, and two disposable local HTTPS endpoints with
#   pinned certificates. No production paths, launchd domains, service
#   processes, or Docker daemon state are touched.
#
# FAKE seams, each isolated under WORK:
#   launchctl        -> records bootstrap/kickstart calls; never invokes launchd
#   docker           -> records inspect/load/tag/rm/exec against a JSON image
#                       store and models parser container health
#   install-venv.sh  -> records native-service staging and creates a disposable
#                       interpreter path
#   chown            -> records root-only hardening without changing ownership
#
# The real `launchctl` contract is intentionally not rehearsed here. The
# production system domain and root ownership remain operator-run concerns; see
# deploy/mac-prod/README.md for that residual boundary.
set -uo pipefail

fatal() { echo "FATAL: $*" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="${1:?usage: e2e-install.sh <workdir> [port] [edge-port]}"
PORT="${2:-18901}"
EDGE_PORT="${3:-$((PORT + 1))}"
# Any release built by scripts/build-gateway.sh; the newest is the default.
TARBALL="$(ls -t "$REPO"/dist/gateway/*.tar.gz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] || fatal "no release in $REPO/dist/gateway — run scripts/build-gateway.sh"
VERSION="$(basename "$TARBALL" .tar.gz)"
# Existing pre-parser archive. Read-only input; install extracts only into WORK.
LEGACY_TARBALL="$REPO/dist/gateway/1.13.1.tar.gz"
[ -f "$LEGACY_TARBALL" ] || fatal "legacy release missing: $LEGACY_TARBALL"
LEGACY_VERSION="$(basename "$LEGACY_TARBALL" .tar.gz)"
[ "$LEGACY_VERSION" != "$VERSION" ] || fatal "legacy release must differ from current release $VERSION"
if tar -tzf "$LEGACY_TARBALL" | grep -q '/addons/attachment-parser/'; then
  fatal "expected legacy release without attachment-parser payload: $LEGACY_TARBALL"
fi
# One version above the release under test, built by re-packing it: the rollback
# case needs a DISTINCT version that fails health.
BAD_VERSION="${VERSION%.*}.$(( ${VERSION##*.} + 1 ))"
export PYTHONUNBUFFERED=1

# Previous rehearsal may have applied GUI-domain a-w hardening; make only the
# disposable tree writable before removing it.
if [ -d "$WORK" ]; then chmod -R u+w "$WORK" 2>/dev/null || true; fi
rm -rf "$WORK"; mkdir -p "$WORK"/{opt,home,launchd,bin,log,stage}
echo "repo=$REPO  release=$VERSION  rollback-probe=$BAD_VERSION  port=$PORT"

# --- root-only stubs ----------------------------------------------------------
cat > "$WORK/bin/launchctl" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/log/launchctl.log"
case "\$1" in
  print) test -f "$WORK/log/launchd.loaded" || exit 1 ;;
  bootstrap|kickstart) touch "$WORK/log/launchd.loaded" ;;
  bootout) rm -f "$WORK/log/launchd.loaded" ;;
  *) exit 1 ;;
esac
exit 0
EOF
cat > "$WORK/bin/chown" <<EOF
#!/bin/sh
echo "\$*" >> "$WORK/log/chown.log"
exit 0
EOF
cat > "$WORK/bin/docker" <<'PY'
#!/usr/bin/env python3
"""Disposable Docker CLI model for installer rehearsal."""
import json
import os
import sys
import tarfile
from pathlib import Path

state_path = Path(os.environ["SENTIENT_FAKE_DOCKER_STATE"])
log_path = Path(os.environ["SENTIENT_FAKE_DOCKER_LOG"])
try:
    state = json.loads(state_path.read_text())
except FileNotFoundError:
    state = {"images": {}}

def save():
    state_path.write_text(json.dumps(state, sort_keys=True))

def record(argv):
    with log_path.open("a") as log:
        log.write(json.dumps(argv) + "\n")

def fail():
    save()
    raise SystemExit(1)

def image_record(ref):
    record = state["images"].get(ref)
    if record is None:
        fail()
    return record

def inspect(ref):
    image = image_record(ref)
    labels = image["labels"]
    print(json.dumps([{"Id": image["id"], "Config": {"Labels": labels}}]))

def load(archive):
    archive = Path(archive)
    identity = json.loads((archive.parent / "identity.json").read_text())
    metadata = json.loads((archive.parent / "addon.json").read_text())
    image = identity["image"]
    labels = {
        "io.sentient.addon.name": metadata["name"],
        "org.opencontainers.image.version": metadata["version"],
        "io.sentient.addon.protocol-version": str(metadata["protocolVersion"]),
        "org.opencontainers.image.revision": image["revision"],
    }
    record = {"id": image["imageId"], "labels": labels, "metadata": metadata}
    state["images"][image["ref"]] = record
    state["images"][image["imageId"]] = record
    save()

def tag(source, target):
    state["images"][target] = dict(image_record(source))
    save()

def remove(ref):
    image_record(ref)
    del state["images"][ref]
    save()

def container_inspect():
    alias = state["images"].get("sentient/attachment-parser:local")
    if alias is None:
        fail()
    running = not Path(os.environ["SENTIENT_FAKE_DOCKER_DOWN"]).exists()
    print(json.dumps([{"Image": alias["id"], "State": {"Running": running}}]))

def health():
    alias = state["images"].get("sentient/attachment-parser:local")
    if alias is None or Path(os.environ["SENTIENT_FAKE_DOCKER_DOWN"]).exists():
        fail()
    print(json.dumps(alias["metadata"], sort_keys=True))

argv = sys.argv[1:]
record(argv)
if argv[:2] == ["image", "inspect"] and len(argv) == 3:
    inspect(argv[2])
elif argv[:2] == ["container", "inspect"] and len(argv) == 3:
    container_inspect()
elif argv[:1] == ["load"] and "--input" in argv:
    load(argv[argv.index("--input") + 1])
elif argv[:2] == ["image", "tag"] and len(argv) == 4:
    tag(argv[2], argv[3])
elif argv[:2] == ["image", "rm"] and len(argv) == 3:
    remove(argv[2])
elif argv[:2] == ["exec", "sentient-attachment-parser"]:
    health()
else:
    fail()
PY
chmod +x "$WORK/bin/launchctl" "$WORK/bin/chown" "$WORK/bin/docker"
export SENTIENT_FAKE_DOCKER_STATE="$WORK/log/docker-state.json"
export SENTIENT_FAKE_DOCKER_LOG="$WORK/log/docker.log"
export SENTIENT_FAKE_DOCKER_DOWN="$WORK/PARSER_DOWN"
: > "$SENTIENT_FAKE_DOCKER_LOG"

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
export SENTIENT_MAC_PROD_TEST_VENV_HELPER="$SHADOW/deploy/mac-prod/native/install-venv.sh"

require_fake_seams() {
  local seam
  for seam in launchctl docker chown; do
    [ -x "$WORK/bin/$seam" ] || fatal "fake $seam seam missing or not executable"
    [ "$(PATH="$WORK/bin:$PATH" command -v "$seam")" = "$WORK/bin/$seam" ] || \
      fatal "fake $seam seam is not first in PATH"
  done
  [ -x "${SENTIENT_MAC_PROD_TEST_VENV_HELPER:-}" ] || \
    fatal "fake install-venv seam missing or not executable"
}

run() {  # run <case-name> [installer args...]
  local name="$1"; shift
  local anchor="${ANCHOR:-$WORK/cert.pem}"
  local edge_anchor="${EDGE_ANCHOR:-$WORK/edge-cert.pem}"
  local status
  require_fake_seams
  PATH="$WORK/bin:$PATH" SUDO_USER="$(id -un)" \
  python3 "$REPO/deploy/mac-prod/setup-prod.py" install "$@" \
    --repo "$SHADOW" --opt-root "$WORK/opt" --home "$WORK/home" \
    --launchd-dir "$WORK/launchd" --ca-bundle "$anchor" \
    --health-url "$URL" --wheels "$REPO/dist/wheels" --keep 2 \
    --health-attempts 6 --health-interval 1 \
    --outward-cert "$edge_anchor" --edge-url "$EDGE_URL" \
    --edge-attempts 6 --edge-interval 1 \
    > "$WORK/log/$name.out" 2>&1
  status=$?
  echo "EXIT=$status"
  return "$status"
}
plain() { sed 's/\x1b\[[0-9;]*m//g' "$WORK/log/$1.out"; }
cur() { basename "$(readlink "$WORK/opt/current" 2>/dev/null || echo NONE)"; }
parser_alias() {
  python3 - "$SENTIENT_FAKE_DOCKER_STATE" <<'PY'
import json
import sys

images = json.loads(open(sys.argv[1]).read())["images"]
print(json.dumps(images["sentient/attachment-parser:local"], sort_keys=True))
PY
}

echo "=== CASE 1: fresh install ==="
run c1 "$TARBALL"; plain c1
echo "current=$(cur)"
echo "plist OPERATOR left=$(grep -c OPERATOR "$WORK/launchd/io.sentient.gateway.plist")  mode=$(stat -f %Sp "$WORK/launchd/io.sentient.gateway.plist")"
echo "launchctl: $(tr '\n' '|' < "$WORK/log/launchctl.log")"
echo "release chowned: $(grep -c "root:wheel.*opt/$VERSION\$" "$WORK/log/chown.log" 2>/dev/null || true)"
echo "secrets mode=$(stat -f %Sp "$WORK/home/.sentient/secrets")"

echo; echo "=== CASE 2: reinstall the same healthy version (idempotent no-op) ==="
: > "$WORK/log/launchctl.log"
run c2 "$TARBALL"; plain c2
echo "launchctl calls=[$(tr '\n' '|' < "$WORK/log/launchctl.log")]  current=$(cur)"

echo; echo "=== CASE 3: operator config is never clobbered ==="
cat > "$WORK/home/.sentient/gateway/config/config.yaml" <<'EOF'
orchestrator: {model: operator-tuned}
managed_services:
  attachment-parser:
    template: attachment-parser.yaml
EOF
run c3 "$TARBALL" > /dev/null
echo "config now: $(cat "$WORK/home/.sentient/gateway/config/config.yaml")"

echo; echo "=== CASE 4: missing parser config refuses before Docker side effects ==="
cat > "$WORK/home/.sentient/gateway/config/config.yaml" <<'EOF'
managed_services:
  egress-proxy:
    template: egress-proxy.yaml
EOF
before_loads=$(grep -c '"load"' "$SENTIENT_FAKE_DOCKER_LOG" || true)
run c4 "$TARBALL"; plain c4 | tail -3
after_loads=$(grep -c '"load"' "$SENTIENT_FAKE_DOCKER_LOG" || true)
echo "docker loads before=$before_loads after=$after_loads (expected unchanged)"
cat > "$WORK/home/.sentient/gateway/config/config.yaml" <<'EOF'
orchestrator: {model: operator-tuned}
managed_services:
  attachment-parser:
    template: attachment-parser.yaml
EOF

echo; echo "=== CASE 5: bad checksum refuses, even matching the running version ==="
cp "$TARBALL" "$WORK/$VERSION-bad.tar.gz"
printf '%064d  x\n' 0 > "$WORK/$VERSION-bad.tar.gz.sha256"
: > "$WORK/log/launchctl.log"
run c4 "$WORK/$VERSION-bad.tar.gz"; plain c4 | tail -2
echo "current=$(cur)  launchctl=[$(tr '\n' '|' < "$WORK/log/launchctl.log")]"

echo; echo "=== CASE 6: health failure rolls back to the previous version ==="
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

echo; echo "=== CASE 7: pruning keeps current + the rollback target ==="
ls "$WORK/opt" | grep -v current | tr '\n' ' '; echo

echo; echo "=== CASE 8: the anchor the gateway has not minted yet ==="
# The fresh-host race: on a genuinely new mini ~/.sentient/gateway/certs/cert.pem does
# not exist until the gateway the installer just started mints it. The probe must
# WAIT for it, not abort the install. Before this was fixed, the missing-anchor
# error escaped install() past the rollback and left `current` on the new,
# unverified release.
# GUI-domain release hardening removes write bits; restore them only inside
# disposable WORK before deleting it.
chmod -R u+w "$WORK/opt" 2>/dev/null || true
rm -rf "$WORK/opt" "$WORK/late"; mkdir -p "$WORK/opt" "$WORK/late"
( sleep 3; cp "$WORK/cert.pem" "$WORK/late/cert.pem" ) &
: > "$WORK/log/launchctl.log"
ANCHOR="$WORK/late/cert.pem" run c7 "$TARBALL"; plain c7 | tail -2
echo "current=$(cur)  (expected $VERSION, installed while waiting for the anchor)"

echo; echo "=== CASE 9: edge (443) down while the gateway (8888) stays healthy ==="
# Reuse failed candidate directory only after undoing disposable GUI hardening.
chmod -R u+w "$WORK/opt/releases/$BAD_VERSION" 2>/dev/null || true
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
echo "distinguishing message present (install + rollback re-check = 2): $(grep -c 'gateway and attachment-parser healthy, edge not' "$WORK/log/c8.out")"
echo "generic 'gateway not healthy' wrongly claimed: $(grep -c 'gateway not healthy —' "$WORK/log/c8.out")  (expected 0 — gateway was fine the whole time)"

echo; echo "=== CASE 10: parser health is independently gated and rolled back ==="
chmod -R u+w "$WORK/opt/releases/$BAD_VERSION" 2>/dev/null || true
touch "$SENTIENT_FAKE_DOCKER_DOWN"
: > "$WORK/log/launchctl.log"
run c10 "$WORK/$BAD_VERSION.tar.gz"; plain c10 | tail -8
rm -f "$SENTIENT_FAKE_DOCKER_DOWN"
echo "current after parser-health failure=$(cur)  (expected $VERSION)"
echo "parser health failures: $(grep -c 'attachment-parser not ready' "$WORK/log/c10.out" || true)"

echo; echo "=== CASE 11: legacy candidate installs over paired current ==="
[ "$(cur)" = "$VERSION" ] || fatal "legacy candidate must start over paired current $VERSION, found $(cur)"
[ -f "$WORK/opt/releases/$VERSION/addons/attachment-parser/identity.json" ] || \
  fatal "legacy candidate must start over a current release with parser payload"
legacy_alias_before="$(parser_alias)" || fatal "fake Docker alias state unavailable before legacy install"
legacy_status=0
run c11 "$LEGACY_TARBALL" || legacy_status=$?
plain c11
[ "$legacy_status" -eq 0 ] || fatal "legacy candidate exited $legacy_status"
[ "$(cur)" = "$LEGACY_VERSION" ] || fatal "legacy candidate did not become current: $(cur)"
legacy_alias_after="$(parser_alias)" || fatal "fake Docker alias state unavailable after legacy install"
[ "$legacy_alias_before" = "$legacy_alias_after" ] || \
  fatal "legacy candidate changed sentient/attachment-parser:local"
[ ! -e "$WORK/opt/.attachment-parser-legacy.json" ] || \
  fatal "legacy candidate unexpectedly created a parser receipt"
if grep -Eiq 'receipt|legacy rollback target' "$WORK/log/c11.out"; then
  fatal "legacy candidate attempted a receipt lookup"
fi
echo "assertions: exit=0 current=$LEGACY_VERSION parser-alias-unchanged receipt-lookup=absent"

echo; echo "=== END ==="
