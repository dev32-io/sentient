### Task 5: Installer — `setup-prod.py` rewrite

**Wave 2 · model: opus · spec §7**

Runs concurrently with Task 4. **Do not touch `gateway/config.yaml`** — Task 4 owns it this wave. You write against the layout Task 4 establishes.

**Files:**
- Modify: `deploy/mac-prod/setup-prod.py` (rewrite)
- Create: `deploy/mac-prod/tests/test_setup_prod.py`

**Interfaces:**

Consumes: `scripts/build-gateway.sh` output (`dist/gateway/<version>.tar.gz` + `.sha256`), `deploy/mac-prod/native/install-venv.sh`, `deploy/mac-prod/io.sentient.gateway.plist`.

Produces: `/opt/sentient/<version>/`, `/opt/sentient/current` symlink, a loaded `io.sentient.gateway` LaunchDaemon.

**The rollback path is the highest-risk logic in this plan.** A rollback that itself fails leaves the mini down with no assistant. It is tested first and hardest.

---

- [ ] **Step 1: Read the current script and record what it does**

```bash
sed -n '1,80p' deploy/mac-prod/setup-prod.py
grep -nE "^def |compose|docker" deploy/mac-prod/setup-prod.py | head -30
```
Record the existing entry points and anything the operator depends on today. This is a deliberate replacement, not a blind rewrite — note in your report what behaviour is being dropped.

- [ ] **Step 2: Write the failing tests (rollback first)**

Create `deploy/mac-prod/tests/test_setup_prod.py`:

```python
import pytest
from setup_prod import Installer, InstallError

class FakeFs:
    def __init__(self): self.current = None; self.installed = []
    def unpack(self, version): self.installed.append(version)
    def point_current_at(self, version): self.current = version

class FakeLaunchd:
    def __init__(self): self.kicks = 0
    def kickstart(self): self.kicks += 1

def test_health_failure_rolls_back_to_previous_version():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    # health fails for the new version, succeeds once rolled back
    health = iter([False, True])
    inst = Installer(fs=fs, launchd=ld, health=lambda: next(health), verify_checksum=lambda p: True)

    with pytest.raises(InstallError):
        inst.install("1.13.0", tarball="x.tar.gz")

    assert fs.current == "1.12.0", "must roll back to the previous version"
    assert ld.kicks == 2, "must restart once for the install and once for the rollback"

def test_rollback_verifies_health_after_reverting():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    # both the new version AND the rollback fail health
    inst = Installer(fs=fs, launchd=ld, health=lambda: False, verify_checksum=lambda p: True)

    with pytest.raises(InstallError) as e:
        inst.install("1.13.0", tarball="x.tar.gz")
    assert "rollback" in str(e.value).lower(), "a failed rollback must say so explicitly"

def test_bad_checksum_refuses_before_touching_anything():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.12.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: True, verify_checksum=lambda p: False)

    with pytest.raises(InstallError):
        inst.install("1.13.0", tarball="x.tar.gz")

    assert fs.installed == [], "must not unpack an unverified tarball"
    assert fs.current == "1.12.0"
    assert ld.kicks == 0

def test_reinstalling_the_running_version_is_a_noop():
    fs, ld = FakeFs(), FakeLaunchd()
    fs.point_current_at("1.13.0")
    inst = Installer(fs=fs, launchd=ld, health=lambda: True, verify_checksum=lambda p: True)

    inst.install("1.13.0", tarball="x.tar.gz")

    assert ld.kicks == 0, "idempotent: a healthy identical install must not restart the service"
```

- [ ] **Step 3: Run and confirm failure**

```bash
cd deploy/mac-prod && python3 -m pytest tests/test_setup_prod.py -v
```
Expected: FAIL — `ImportError: cannot import name 'Installer'`.

- [ ] **Step 4: Implement the `Installer` core**

In `deploy/mac-prod/setup-prod.py`, replace the compose orchestration with:

```python
class InstallError(Exception):
    """Install or rollback failed. Message names which, and why."""


class Installer:
    """Install/upgrade the native gateway.

    Ordering is deliberate: verify BEFORE unpacking, and health-gate AFTER
    flipping `current`, so a bad release is caught while the previous version
    is still on disk and can be restored.
    """

    def __init__(self, fs, launchd, health, verify_checksum):
        self._fs = fs
        self._launchd = launchd
        self._health = health
        self._verify_checksum = verify_checksum

    def install(self, version, tarball):
        previous = self._fs.current

        # Idempotent: an identical, healthy install must not bounce the service.
        if previous == version and self._health():
            return

        if not self._verify_checksum(tarball):
            raise InstallError(f"checksum mismatch for {tarball}; refusing to install")

        self._fs.unpack(version)
        self._fs.point_current_at(version)
        self._launchd.kickstart()

        if self._health():
            return

        if previous is None:
            raise InstallError(f"{version} failed health and there is no previous version to roll back to")

        self._fs.point_current_at(previous)
        self._launchd.kickstart()
        if not self._health():
            raise InstallError(
                f"{version} failed health AND the rollback to {previous} also failed health — "
                "the service is down and needs manual intervention"
            )
        raise InstallError(f"{version} failed health; rolled back to {previous}")
```

- [ ] **Step 5: Run to green**

```bash
cd deploy/mac-prod && python3 -m pytest tests/test_setup_prod.py -v
```
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(deploy): installer core with health-gated rollback" -- \
  deploy/mac-prod/setup-prod.py deploy/mac-prod/tests/test_setup_prod.py
```

- [ ] **Step 7: Wire the real filesystem, launchd and health adapters**

These are I/O shells around the tested core — keep them thin so the logic stays under test.

```python
OPT = Path("/opt/sentient")

class RealFs:
    @property
    def current(self):
        link = OPT / "current"
        return link.resolve().name if link.is_symlink() else None

    def unpack(self, version, tarball):
        dest = OPT / version
        dest.mkdir(parents=True, exist_ok=True)
        subprocess.run(["tar", "-xzf", tarball, "-C", str(OPT)], check=True)
        # CODE IS ROOT-OWNED: the service user must not be able to rewrite its
        # own binary. This is the whole reason code does not live under $HOME.
        subprocess.run(["chown", "-R", "root:wheel", str(dest)], check=True)
        subprocess.run(["chmod", "-R", "755", str(dest)], check=True)

    def point_current_at(self, version):
        tmp = OPT / ".current.tmp"
        if tmp.exists() or tmp.is_symlink():
            tmp.unlink()
        tmp.symlink_to(OPT / version)
        tmp.replace(OPT / "current")   # atomic swap
```

Health polls `https://127.0.0.1:8888/api/v1/health` with a bounded retry budget and a hard timeout.

**Do not disable TLS verification.** The gateway mints its own CA into `~/.sentient/certs/` on first boot, so verify against that bundle rather than passing `verify=False` — a plan that says "turn verification off" gets copied into places where the target is not loopback:

```python
CA_BUNDLE = Path.home() / ".sentient/certs/ca.crt"

def health() -> bool:
    try:
        # Pin the gateway's own CA. If it is genuinely absent the install is
        # broken anyway — fail closed rather than silently trusting anything.
        r = requests.get("https://127.0.0.1:8888/api/v1/health",
                         verify=str(CA_BUNDLE), timeout=5)
        return r.ok
    except requests.RequestException:
        return False
```

Confirm the actual CA filename under `~/.sentient/certs/` before writing this — use the real one, not the placeholder.

- [ ] **Step 8: Ensure user-owned state, never overwriting operator config**

```python
def ensure_state_dirs(home: Path):
    for d in ["gateway/config", "gateway/logs", "gateway/users", "secrets", "certs", "run"]:
        (home / ".sentient" / d).mkdir(parents=True, exist_ok=True)
    secrets = home / ".sentient" / "secrets"
    secrets.chmod(0o700)
    keys = secrets / "keys.yaml"
    if keys.exists():
        keys.chmod(0o600)
    # HARD RULE: the operator edits config.yaml by hand. Never clobber it.
    cfg = home / ".sentient/gateway/config/config.yaml"
    if not cfg.exists():
        shutil.copy(TEMPLATE_CONFIG, cfg)
```

- [ ] **Step 9: Install venvs offline and the plist**

Call Task 3's helper per service, then install the plist with `OPERATOR` substituted:

```python
for service in ("whisper-stt", "local-tts"):
    subprocess.run([
        str(RELEASE / "native/install-venv.sh"), service,
        str(OPT / version / service / "venv"), str(RELEASE / "wheels" / service),
    ], check=True)
```

- [ ] **Step 10: Prune old releases**

Keep the last N (default 3) plus whatever `current` points at — never prune the rollback target.

- [ ] **Step 11: Verify a real install end to end**

```bash
./scripts/build-gateway.sh --release
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<version>.tar.gz
ls -la /opt/sentient/
launchctl print system/io.sentient.gateway | grep -E "state|path"
curl -sk https://localhost:8888/api/v1/health
```
Expected: versioned dir `root:wheel`, `current` symlink present, daemon running, `{"status":"ok"}`.

- [ ] **Step 12: Verify rollback against the real system**

Install a deliberately broken release (e.g. point `GATEWAY_CONFIG_PATH` at a malformed file) and confirm the installer reverts and the service comes back healthy on the previous version.

```bash
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<broken-version>.tar.gz; echo "EXIT=$?"
readlink /opt/sentient/current
curl -sk https://localhost:8888/api/v1/health
```
Expected: non-zero exit with `rolled back to <previous>`, `current` pointing at the previous version, health `ok`.

- [ ] **Step 13: Commit**

```bash
git commit -m "feat(deploy): native installer with offline venvs, launchd, and pruning" -- \
  deploy/mac-prod/setup-prod.py deploy/mac-prod/tests/test_setup_prod.py
```
