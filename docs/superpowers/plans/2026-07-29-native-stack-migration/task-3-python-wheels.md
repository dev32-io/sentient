### Task 3: Locked requirements + vendored wheels (offline install)

**Wave 1 · model: sonnet · spec §5.1**

**Goal:** nothing reaches PyPI on the mini at deploy time. The compiled Bun binary already gives this for JS; without vendored wheels the property only half-holds.

**Files:**
- Read first: `deploy/mac-prod/native/local-tts.sh`, `deploy/mac-prod/native/whisper-stt.sh` — these already encode the venv + pinned-interpreter conventions. Preserve them exactly.
- Create: `deploy/mac-prod/native/requirements/whisper-stt.lock`
- Create: `deploy/mac-prod/native/requirements/local-tts.lock`
- Create: `scripts/build-python-wheels.sh`
- Create: `deploy/mac-prod/native/install-venv.sh`

**Interfaces:**

Produces (Task 5's installer calls this):
```bash
install-venv.sh <service> <venv-dir> <wheels-dir>
# exits 0 on success; non-zero with a named cause on any failure.
# MUST NOT reach the network under any circumstance.
```

**Pinned interpreters are load-bearing.** `local-tts` → Python **3.11** (mlx-audio publishes no 3.14 wheels), `whisper-stt` → Python **3.14**. Do not "modernise" these.

---

- [ ] **Step 1: Read the existing launchers and record the conventions**

```bash
cat deploy/mac-prod/native/local-tts.sh
cat deploy/mac-prod/native/whisper-stt.sh
```
Note in your report: where each venv currently lives, how the interpreter is selected, and what env each service needs. The new scripts must produce venvs those launchers (or their Task 4 successors) can use unchanged.

- [ ] **Step 2: Generate fully-pinned, hash-checked lockfiles**

For each service, from its current working venv:

```bash
# whisper-stt (python 3.14)
~/.sentient/whisper-stt/.venv/bin/pip freeze --all > /tmp/whisper-stt.freeze
pip-compile --generate-hashes --output-file deploy/mac-prod/native/requirements/whisper-stt.lock /tmp/whisper-stt.freeze
```
If `pip-compile` (pip-tools) is unavailable, `pip freeze` plus `pip hash` per wheel is acceptable — but **every entry must carry a `--hash=sha256:...`**. A lockfile without hashes does not prevent substitution and fails the point of this task.

- [ ] **Step 3: Write the wheel-build script**

`scripts/build-python-wheels.sh`:

```bash
#!/usr/bin/env bash
# Build vendored wheels for every native Python service, so the installer can
# run fully offline. Wheels are arm64 macOS and MUST be built against each
# service's PINNED interpreter — a wheel built for 3.11 will not install into a
# 3.14 venv, and the failure is confusing (it looks like a missing package).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REQ="$REPO/deploy/mac-prod/native/requirements"
OUT="$REPO/dist/wheels"

build() {
  local service="$1" pyver="$2"
  local py; py="$(command -v "python$pyver")" || {
    echo "FAIL: python$pyver not found — $service pins it" >&2; exit 1; }
  echo "==> $service (python$pyver)"
  rm -rf "$OUT/$service"; mkdir -p "$OUT/$service"
  "$py" -m pip wheel -r "$REQ/$service.lock" -w "$OUT/$service"
}

build whisper-stt 3.14
build local-tts   3.11     # 3.11 REQUIRED: mlx-audio ships no 3.14 wheels

echo "✓ wheels in $OUT"
```

- [ ] **Step 4: Run it**

```bash
chmod +x scripts/build-python-wheels.sh && ./scripts/build-python-wheels.sh
ls dist/wheels/whisper-stt | head -5
ls dist/wheels/local-tts   | head -5
```
Expected: both directories populated with `.whl` files. A missing pinned interpreter fails loudly by design.

- [ ] **Step 5: Write the offline installer helper**

`deploy/mac-prod/native/install-venv.sh`:

```bash
#!/usr/bin/env bash
# Create a service venv from VENDORED WHEELS ONLY. --no-index is what guarantees
# no PyPI access; if a wheel is missing this fails loudly rather than silently
# falling back to the network.
set -euo pipefail
SERVICE="${1:?service name required}"
VENV="${2:?venv dir required}"
WHEELS="${3:?wheels dir required}"

case "$SERVICE" in
  whisper-stt) PYVER=3.14 ;;
  local-tts)   PYVER=3.11 ;;   # mlx-audio has no 3.14 wheels
  *) echo "FAIL: unknown service $SERVICE" >&2; exit 1 ;;
esac

PY="$(command -v "python$PYVER")" || { echo "FAIL: python$PYVER not installed" >&2; exit 1; }

# Verify BEFORE installing: a venv on the wrong minor accepts the command and
# then fails to import at runtime, which is far harder to diagnose.
ACTUAL="$("$PY" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
[ "$ACTUAL" = "$PYVER" ] || { echo "FAIL: expected python $PYVER, got $ACTUAL" >&2; exit 1; }

"$PY" -m venv "$VENV"
"$VENV/bin/pip" install --no-index --find-links="$WHEELS" \
  -r "$(dirname "$0")/requirements/$SERVICE.lock"
echo "✓ $SERVICE venv ready at $VENV"
```

- [ ] **Step 6: Prove it works offline — this is the whole point of the task**

Disable networking, then install:

```bash
# macOS: turn off Wi-Fi (adjust the interface if yours differs)
networksetup -setairportpower en0 off
rm -rf /tmp/venv-offline-test
./deploy/mac-prod/native/install-venv.sh whisper-stt /tmp/venv-offline-test dist/wheels/whisper-stt
echo "EXIT=$?"
networksetup -setairportpower en0 on
```
Expected: `✓ whisper-stt venv ready`, exit 0, **with networking off**. If it fails with a network error, a wheel is missing from the vendor dir — fix the lockfile, do not add a network fallback.

- [ ] **Step 7: Prove the negative case**

```bash
networksetup -setairportpower en0 off
rm -rf /tmp/venv-neg-test
mkdir -p /tmp/empty-wheels
./deploy/mac-prod/native/install-venv.sh whisper-stt /tmp/venv-neg-test /tmp/empty-wheels
echo "EXIT=$?"
networksetup -setairportpower en0 on
```
Expected: **non-zero exit** with a pip error naming an unfindable distribution — proving `--no-index` is doing real work rather than silently reaching out.

- [ ] **Step 8: Commit**

```bash
chmod +x deploy/mac-prod/native/install-venv.sh
git commit -m "feat(deploy): vendored wheels so python services install offline" -- \
  scripts/build-python-wheels.sh \
  deploy/mac-prod/native/install-venv.sh \
  deploy/mac-prod/native/requirements/
```

- [ ] **Step 9: Record the hermes question in your report**

Spec §4 places a hermes venv at `/opt/sentient/<version>/hermes/venv`, but hermes is currently operator-installed at `~/.hermes/`. State explicitly whether this task provisions it or only documents the expected layout — **do not silently assume**. If hermes stays operator-installed, Task 4's launchd env must put its launcher on `PATH`, and that dependency belongs in your report so Task 4 picks it up.
