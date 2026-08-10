### Task 8b: Fix the four defects the migration E2E found

**Wave 4 (addendum) · model: opus · blocks T9/T10**

T8 drove the real stack and found four defects that 1111 unit tests could not — every one concerns runtime behaviour or deployment shape, which is precisely what unit tests structurally cannot reach. None fall under any task's ownership in the wave table, so they are collected here.

**Files:**
- Modify: `capabilityServices/WhisperSTTService/config/config.example.yaml`, `capabilityServices/STTService/config/config.example.yaml`
- Modify: `gateway/src/system-orchestrator/orchestrator.ts` (+ `index.ts` wiring), `gateway/src/system-orchestrator/native-driver.ts` (stale comment)
- Create: `gateway/src/system-orchestrator/health-watch.ts` + test
- Modify: `gateway/src/config/startup-config.ts`, `deploy/mac-prod/io.sentient.gateway.plist`
- Modify: `gateway/src/bootstrap/create-gateway-services.ts`
- Modify: `gateway/config.yaml` (health-watch interval — a new tunable)

---

- [ ] **Step 1: State probe**

```bash
git log --oneline -8
git status --short
grep -n "host:" capabilityServices/WhisperSTTService/config/config.example.yaml
grep -rn "setInterval" gateway/src/system-orchestrator/*.ts | grep -v '\.test\.'
```

---

#### Defect 1 — SECURITY: whisper-stt is LAN-reachable

- [ ] **Step 2: Confirm the exposure and the correct pattern**

```bash
grep -rn "host:" capabilityServices/*/config/config.example.yaml
```
Expected: `LocalTTSService` → `127.0.0.1` (correct); `WhisperSTTService` and `STTService` → `"0.0.0.0"` (wrong — a container-era default, where `0.0.0.0` meant "reachable inside the docker network"). Now that these run as host processes, `0.0.0.0` means the LAN.

Spec §3 is explicit: `whisper-stt` and `local-tts` bind `127.0.0.1`, localhost only. The gateway is the sole consumer of both.

- [ ] **Step 3: Fix both, and say why in the file**

```yaml
  # Loopback ONLY. The gateway is the sole consumer and runs on the same host.
  # This was "0.0.0.0" when the service ran in a container, where that meant
  # "reachable on the docker network"; as a native host process it means the LAN.
  host: 127.0.0.1
```
Apply to `WhisperSTTService`. For `STTService`: its container was deleted in the cutover — **verify whether anything still launches it** (`grep -rn "STTService" gateway/src deploy --include='*.ts' --include='*.yaml'`). If it is dead, say so in your report and fix the value anyway (a dead example config that teaches `0.0.0.0` is a trap for whoever revives it); if it is live, fix it as a live exposure.

- [ ] **Step 4: Verify against the running service, both directions**

```bash
LAN_IP=$(ipconfig getifaddr en0)
# restart whisper-stt so it picks up the new bind, then:
echo -n "loopback (must ANSWER): "; nc -z 127.0.0.1 8768 && echo open || echo closed
echo -n "LAN      (must REFUSE): "; nc -z -w 3 "$LAN_IP" 8768 && echo "OPEN — STILL EXPOSED" || echo "refused (correct)"
```
Expected: loopback open, LAN refused. This is the same assertion `loopback-only-exposure` failed on.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(services): bind whisper-stt to loopback instead of every interface" -- \
  capabilityServices/WhisperSTTService/config/config.example.yaml \
  capabilityServices/STTService/config/config.example.yaml
```

---

#### Defect 2 — a crashed addon never recovers

- [ ] **Step 6: Confirm the gap**

```bash
grep -rn "pollHealthy" gateway/src/system-orchestrator/*.ts | grep -v '\.test\.'
sed -n '1,12p' gateway/src/system-orchestrator/native-driver.ts
```
Expected: `pollHealthy` is called **only** from inside `orchestrator.ts`'s apply path. `apply()` runs at boot, from the admin endpoint, and from the wizard — never on a post-boot crash. Meanwhile `native-driver.ts`'s header claims *"Restart is the orchestrator's call — a health probe failure re-applies."* That claim is false today: T8 killed an addon and watched 65s with zero recovery.

Spec §2 promises "restart on crash". This is the unimplemented half.

- [ ] **Step 7: Write the failing test**

Create `gateway/src/system-orchestrator/health-watch.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createHealthWatch } from "./health-watch.js";

describe("health-watch", () => {
  it("INVARIANT: an unhealthy service triggers exactly one re-apply", async () => {
    const applied: string[] = [];
    let healthy = false;
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => healthy,
      reapply: async (name) => { applied.push(name); healthy = true; },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 60));
    watch.stop();
    expect(applied).toEqual(["local-tts"]);   // recovered, and NOT re-applied once healthy
  });

  it("INVARIANT: a healthy service is never re-applied", async () => {
    const applied: string[] = [];
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => true,
      reapply: async (name) => { applied.push(name); },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 60));
    watch.stop();
    expect(applied).toEqual([]);
  });

  it("INVARIANT: stop() ends the loop — no re-apply after shutdown", async () => {
    const applied: string[] = [];
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => false,
      reapply: async (name) => { applied.push(name); },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 25));
    watch.stop();
    const countAtStop = applied.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(applied.length).toBe(countAtStop);
  });
});
```

- [ ] **Step 8: Run and confirm it fails**

```bash
cd gateway/src && bun test system-orchestrator/health-watch.test.ts
```
Expected: FAIL — `Cannot find module './health-watch.js'`.

- [ ] **Step 9: Implement `health-watch.ts`**

Design constraints, all load-bearing:
- **Never re-apply a healthy service** (test 2) — this is a watchdog, not a restart loop.
- **Back off on repeated failure.** A service that cannot start must not be re-applied every tick forever; cap the attempts or widen the interval, and log the give-up with a `reason`.
- **`stop()` must be honoured** (test 3) so gateway shutdown does not leave a timer re-applying into a torn-down driver.
- **Never overlap with an in-flight `apply()`** — a watchdog re-apply racing an operator apply on the same service is a real hazard. Guard it.
- Tagged logger; every transition logged with a `reason`.

- [ ] **Step 10: Run to green, then wire it in**

```bash
cd gateway/src && bun test system-orchestrator/health-watch.test.ts
```
Then start it from `index.ts` after the boot reconcile, stop it on shutdown, and add the interval as a YAML tunable (spec's config rule — no magic numbers):

```yaml
  # How often the orchestrator re-probes addon health after boot and re-applies
  # anything that has gone unhealthy. Range 5000-300000. Without this a crashed
  # addon never recovers: apply() otherwise runs only at boot/admin/wizard.
  health_watch_interval_ms: 15000
```

- [ ] **Step 11: Fix the stale comment in `native-driver.ts`**

Its header currently asserts behaviour that did not exist. Now that it does, make the comment name where it lives (`health-watch.ts`) rather than implying the driver does it.

- [ ] **Step 12: Verify against the real stack — the case that failed**

```bash
PID=$(pgrep -f local_tts | head -1); echo "killing $PID"; kill -9 "$PID"
sleep 30
pgrep -fl local_tts && echo "RECOVERED" || echo "STILL DEAD — defect not fixed"
grep -E "health-watch" ~/.sentient/gateway/logs/$(date +%F).log | tail -5
```
Expected: recovered, with a log line naming the service and the reason.

- [ ] **Step 13: Commit**

```bash
git commit -m "feat(orchestrator): re-apply an addon that goes unhealthy after boot" -- \
  gateway/src/system-orchestrator/ gateway/config.yaml
```

---

#### Defects 3 & 4 — would crash-loop a real first install

- [ ] **Step 14: Confirm both**

```bash
grep -n "LOG_DIR\|GATEWAY_CERTS_DIR" gateway/src/config/startup-config.ts
sed -n '170,180p' gateway/src/bootstrap/create-gateway-services.ts
```
Expected: relative-path defaults for the log/certs dirs, and `hostConfigDirContainerPath` defaulting to a literal `/sentient`. Both are container-era assumptions. Under real launchd there is **no `WorkingDirectory`**, and a compiled binary's `import.meta.dir` is bunfs-virtual — so a relative default resolves against `/` and the process crash-loops with `EROFS`.

- [ ] **Step 15: Fix — absolute defaults, and set them in the plist**

Make both default to absolute paths under `~/.sentient/` (the state root), and add them explicitly to `deploy/mac-prod/io.sentient.gateway.plist`'s `EnvironmentVariables` so the deployed shape never relies on the default. Belt and braces: the code must not crash if the plist is missing the var.

Fix `hostConfigDirContainerPath` to resolve from `SENTIENT_HOME` rather than falling back to `/sentient`.

- [ ] **Step 16: Verify the compiled binary boots from `/`**

This reproduces the real launchd condition — no working directory:

```bash
./scripts/build-gateway.sh
cd / && GATEWAY_RUNTIME_DIR="$OLDPWD/dist/gateway/$(node -p "require('$OLDPWD/gateway/package.json').version")/share" \
  "$OLDPWD/dist/gateway/$(node -p "require('$OLDPWD/gateway/package.json').version")/bin/sentient-gateway" 2>&1 | head -12
```
Expected: it reaches config loading or starts — **not** an `EROFS`/relative-path failure. That distinction is the whole point.

- [ ] **Step 17: Full gate + commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
git commit -m "fix(gateway): absolute log and certs defaults so launchd can boot the binary" -- \
  gateway/src/config/startup-config.ts gateway/src/bootstrap/create-gateway-services.ts \
  deploy/mac-prod/io.sentient.gateway.plist
```

- [ ] **Step 18: Re-run the two failed E2E cases and update the evidence**

Re-drive `loopback-only-exposure` and `addon-crash-restart` from `qa/native/`, and update `qa/native/README.md`'s results table from FAIL to PASS with the new evidence. Leave `code-immutability` / `offline-install` as BLOCKED-on-root — those are genuine operator-handoff items, not things to force.
