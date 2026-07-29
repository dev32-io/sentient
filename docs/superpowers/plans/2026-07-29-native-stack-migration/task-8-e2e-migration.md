### Task 8: Migration E2E cases

**Wave 4 · model: sonnet · spec §9.3**

These prove the migration itself and run **before** the 2.0 matrix (Tasks 9/10) — a red migration case makes every later row untrustworthy.

**Files:**
- Create: `qa/native/README.md` (how to run these)
- Create: `qa/native/evidence/<date>-<case>/` per case
- Modify: `agents/docs/testing-knowledge.md` (add the reusable cases)

**Pre-state for every case:** the native gateway installed per Task 5, addons up via compose, `launchctl print system/io.sentient.gateway` showing `state = running`.

A case is green only when **both** the observable behaviour and the log trail match, with no unexpected WARN/ERROR. Capture evidence under the gitignored `qa/` dirs.

---

- [ ] **Step 1: `native-addon-lifecycle`**

| Field | Value |
|---|---|
| Pre-state | gateway stopped, no whisper-stt / local-tts processes |
| Action | `sudo launchctl kickstart -k system/io.sentient.gateway`, wait for health |
| Expected | both native addons running; both tcp healthchecks green |
| Log trail | `[system-orch:native-driver] native.started` ×2 with pids; `registry.built` listing both |

```bash
pgrep -fl "whisper_stt|local_tts" || echo "none running (expected pre-state)"
sudo launchctl kickstart -k system/io.sentient.gateway
sleep 20
pgrep -fl "whisper_stt|local_tts"
curl -s http://127.0.0.1:8766 -o /dev/null -w "stt:%{http_code}\n" || echo "stt: tcp open"
grep -E "native.started|registry.built" ~/.sentient/gateway/logs/$(date +%F).log | tail -5
```

Then the shutdown half — **no orphans** is the invariant:
```bash
sudo launchctl kill SIGTERM system/io.sentient.gateway
sleep 5
pgrep -fl "whisper_stt|local_tts" && echo "FAIL: orphaned addons" || echo "ok: no orphans"
```

- [ ] **Step 2: `addon-crash-restart`**

| Field | Value |
|---|---|
| Pre-state | gateway running, both addons healthy |
| Action | `kill -9` the local-tts pid |
| Expected | driver restarts it; health recovers within the healthcheck timeout |
| Log trail | a crash/restart line naming `local-tts` with a `reason` |

```bash
PID=$(pgrep -f local_tts | head -1); echo "killing $PID"; kill -9 "$PID"
sleep 15
pgrep -fl local_tts && echo "ok: restarted"
grep -E "local-tts" ~/.sentient/gateway/logs/$(date +%F).log | tail -5
```

- [ ] **Step 3: `loopback-only-exposure` — a security assertion, so prove both directions**

| Field | Value |
|---|---|
| Action | probe each addon port on `127.0.0.1` and on the host's LAN IP |
| Expected | loopback **answers**; LAN **refuses**. Gateway `8888` answers on both. |

```bash
LAN_IP=$(ipconfig getifaddr en0); echo "LAN IP: $LAN_IP"
for p in 8086 8668 8087 8080; do
  lo=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/" 2>/dev/null || echo "conn-refused")
  lan=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "http://$LAN_IP:$p/" 2>/dev/null || echo "conn-refused")
  echo "port $p  loopback=$lo  lan=$lan"
done
curl -sk -o /dev/null -w "gateway on LAN: %{http_code}\n" "https://$LAN_IP:8888/api/v1/health"
```
Expected: every addon `lan=conn-refused`; gateway answers `200`. **Any addon answering on the LAN IP fails this case** — do not proceed to Tasks 9/10 until fixed.

- [ ] **Step 4: `code-immutability`**

| Field | Value |
|---|---|
| Action | as the service user, attempt to write the installed binary |
| Expected | permission denied |

```bash
echo "x" >> /opt/sentient/current/bin/sentient-gateway 2>&1 | head -1
ls -l /opt/sentient/current/bin/sentient-gateway
ls -ld /opt/sentient /opt/sentient/current
```
Expected: `Permission denied`; the binary and both parent dirs owned `root:wheel`. A writable binary means a compromised gateway can rewrite itself — the entire reason code does not live under `$HOME`.

- [ ] **Step 5: `upgrade-rollback`**

| Field | Value |
|---|---|
| Action | install a release that fails health |
| Expected | installer reverts `current` and the service is healthy on the previous version |

```bash
readlink /opt/sentient/current   # record the current version
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<broken>.tar.gz; echo "EXIT=$?"
readlink /opt/sentient/current   # must be the PREVIOUS version
curl -sk https://127.0.0.1:8888/api/v1/health
```
Expected: non-zero exit whose message names the rollback; `current` restored; health `ok`.

- [ ] **Step 6: `offline-install`**

| Field | Value |
|---|---|
| Action | run the installer with networking disabled |
| Expected | completes successfully — proving nothing fetches at deploy |

```bash
networksetup -setairportpower en0 off
sudo python3 deploy/mac-prod/setup-prod.py install dist/gateway/<version>.tar.gz; echo "EXIT=$?"
networksetup -setairportpower en0 on
```
Expected: exit 0 with networking off. Any network error means a wheel is missing or a dep is unvendored — fix the vendoring, never add a network fallback.

- [ ] **Step 7: Record results and hand off anything undrivable**

Write each case's evidence to `qa/native/evidence/<date>-<case>/` (command output + relevant log excerpt) and add the six as reusable cases in `agents/docs/testing-knowledge.md`.

If any case could not be driven by an agent, **add it to Task 11's handoff list with the reason** — do not quietly skip it.

- [ ] **Step 8: Commit**

```bash
git commit -m "test(e2e): migration cases for native addons, exposure and rollback" -- \
  qa/native/ agents/docs/testing-knowledge.md
```
