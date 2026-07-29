### Task 4: The cutover — launchd, `/opt` layout, loopback publishing

**Wave 2 · model: opus · spec §2, §3, §4**

**This is the slice where `delegateTask` starts working.** After it, the gateway and hermes share a filesystem, so `Bun.spawn(["hermes", …])` resolves.

**You are the sole owner of `gateway/config.yaml` this wave.** Task 5 runs concurrently and owns only `deploy/mac-prod/setup-prod.py`.

**Files:**
- Modify: `gateway/config.yaml` (MCP urls → loopback; stt/tts urls → loopback)
- Modify: `gateway/src/system-orchestrator/types.ts` — `ServiceTemplateSchema.ports`
- Modify: `deploy/macos/docker-compose.yml`, `deploy/mac-prod/docker-compose.yml`
- Modify: `gateway/mcp/*/` compose templates that need loopback publishing
- Create: `deploy/mac-prod/io.sentient.gateway.plist`
- Delete: `gateway/Dockerfile`, `deploy/hermes-overlay/`
- Test: `gateway/src/system-orchestrator/types.test.ts`

**Consumes:** Task 1's `launch` discriminator and native driver; Task 2's `build-gateway.sh` output layout; Task 3's `install-venv.sh`.

---

- [ ] **Step 1: Write the failing test for loopback-only port publishing**

`ServiceTemplateSchema` currently contains `ports: z.never().optional()` — host ports are forbidden outright. That rule existed because the gateway shared the docker network. It must now *permit* ports while *requiring* the loopback bind, or a bare `"8086:8086"` silently publishes on `0.0.0.0` and puts every MCP on the LAN.

In `gateway/src/system-orchestrator/types.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { ServiceTemplateSchema } from "./types.js";

const base = {
  image: "sentient/ha-mcp:local",
  container_name: "sentient-ha-mcp",
  networks: ["sentient-internal"],
};

describe("ServiceTemplateSchema — port publishing", () => {
  it("SECURITY: accepts a loopback-bound port mapping", () => {
    const r = ServiceTemplateSchema.safeParse({ ...base, ports: ["127.0.0.1:8086:8086"] });
    expect(r.success).toBe(true);
  });

  it("SECURITY: REJECTS a port mapping with no bind address (docker defaults to 0.0.0.0 = LAN)", () => {
    const r = ServiceTemplateSchema.safeParse({ ...base, ports: ["8086:8086"] });
    expect(r.success).toBe(false);
  });

  it("SECURITY: REJECTS an explicitly wildcard-bound port mapping", () => {
    const r = ServiceTemplateSchema.safeParse({ ...base, ports: ["0.0.0.0:8086:8086"] });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd gateway/src && bun test system-orchestrator/types.test.ts
```
Expected: FAIL — the loopback case fails because `ports: z.never()` rejects *any* value.

- [ ] **Step 3: Implement the loopback-only constraint**

In `gateway/src/system-orchestrator/types.ts`, replace the `ports` field:

```ts
/** Host port publishing. The gateway is native now, so it can no longer reach
 *  addons over the docker network — on macOS Docker Desktop, bridge IPs are not
 *  host-routable, so publishing is unavoidable. It MUST bind loopback: docker's
 *  default bind is 0.0.0.0, which would expose every MCP to the LAN. */
const LoopbackPortSchema = z
  .string()
  .regex(/^127\.0\.0\.1:\d{1,5}:\d{1,5}$/, "ports must bind 127.0.0.1 explicitly (host:container)");

// ...inside ServiceTemplateSchema:
  ports: z.array(LoopbackPortSchema).optional().default([]),
```

- [ ] **Step 4: Run to green**

```bash
cd gateway/src && bun test system-orchestrator/types.test.ts
bun run --filter '@sentient/gateway' typecheck
```
Expected: PASS; typecheck exit 0. Any template previously relying on `ports` being `never` now needs a real value — fix those in Step 5.

- [ ] **Step 5: Commit the schema change**

```bash
git commit -m "feat(orchestrator): permit loopback-only host ports for addons" -- \
  gateway/src/system-orchestrator/types.ts gateway/src/system-orchestrator/types.test.ts
```

- [ ] **Step 6: Publish every docker addon on loopback**

In each MCP service template (and the compose files), add a loopback publish. Example for `ha-mcp`:

```yaml
    ports:
      - "127.0.0.1:8086:8086"   # loopback ONLY — the native gateway dials localhost
```
Apply to: `ha-mcp` (8086), `ma-mcp` (8668), `fetch-mcp`, `searxng-mcp` (8087), `searxng` (8080). **Do not** publish `egress-proxy` — nothing dials it from the host; it is an outbound path and `internal: true` stays untouched.

- [ ] **Step 7: Repoint every URL in `gateway/config.yaml` to loopback**

```bash
grep -nE "url: (ws|http)://" gateway/config.yaml
```
Rewrite each docker-DNS hostname to loopback, e.g.:

```yaml
# before
    url: http://sentient-ha-mcp:8086/mcp
    url: ws://sentient-stt-service:8766
    url: ws://host.docker.internal:8770   # tts — the container→host hop disappears
# after
    url: http://127.0.0.1:8086/mcp
    url: ws://127.0.0.1:8766
    url: ws://127.0.0.1:8770
```
`host.docker.internal` must not survive anywhere — the gateway is no longer in a container.

```bash
grep -rn "host.docker.internal\|sentient-ha-mcp\|sentient-ma-mcp\|sentient-stt-service" gateway/config.yaml
```
Expected: no matches.

- [ ] **Step 8: Remove the gateway, hermes and legacy stt-service containers**

Delete the `gateway`, `hermes` and `stt-service` service blocks from both `deploy/macos/docker-compose.yml` and `deploy/mac-prod/docker-compose.yml`. Then:

```bash
git rm -r gateway/Dockerfile deploy/hermes-overlay/
```
Update both compose file headers: they describe a gateway container that no longer exists.

- [ ] **Step 9: Write the launchd plist**

Create `deploy/mac-prod/io.sentient.gateway.plist`. **LaunchDaemon, not LaunchAgent** — `~/Library/LaunchAgents/` is user-writable, the same hole the root-owned-code design exists to close. It runs unprivileged via `UserName`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>io.sentient.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/sentient/current/bin/sentient-gateway</string>
  </array>
  <!-- Root-owned plist, unprivileged execution. Replace OPERATOR at install time. -->
  <key>UserName</key>         <string>OPERATOR</string>
  <key>RunAtLoad</key>        <true/>
  <key>KeepAlive</key>        <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GATEWAY_RUNTIME_DIR</key>  <string>/opt/sentient/current/share</string>
    <key>GATEWAY_CONFIG_PATH</key>  <string>/Users/OPERATOR/.sentient/gateway/config/config.yaml</string>
    <key>SENTIENT_CODE</key>        <string>/opt/sentient/current</string>
    <!-- hermes is operator-installed; delegateTask execs it by name. -->
    <key>PATH</key>                 <string>/Users/OPERATOR/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>  <string>/Users/OPERATOR/.sentient/gateway/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>/Users/OPERATOR/.sentient/gateway/logs/stderr.log</string>
</dict>
</plist>
```

`PATH` must include the hermes launcher directory — `delegateTask` execs `hermes` by name, and launchd jobs do **not** inherit your shell `PATH`.

- [ ] **Step 10: Verify the plist loads and the gateway serves**

A plist has no unit test. Verify concretely:

```bash
sudo cp deploy/mac-prod/io.sentient.gateway.plist /Library/LaunchDaemons/
sudo sed -i '' "s/OPERATOR/$USER/g" /Library/LaunchDaemons/io.sentient.gateway.plist
sudo chown root:wheel /Library/LaunchDaemons/io.sentient.gateway.plist
sudo chmod 644 /Library/LaunchDaemons/io.sentient.gateway.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.sentient.gateway.plist
launchctl print system/io.sentient.gateway | head -20
curl -sk https://localhost:8888/api/v1/health
```
Expected: `state = running`, and `{"status":"ok"}`.

- [ ] **Step 11: Verify the security boundary — both directions**

This is a security assertion, so prove the negative too:

```bash
LAN_IP=$(ipconfig getifaddr en0)
echo "loopback (must ANSWER):"; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8086/mcp
echo "LAN     (must REFUSE):"; curl -s -m 3 -o /dev/null -w "%{http_code}\n" "http://$LAN_IP:8086/mcp" || echo "refused (expected)"
echo "gateway on LAN (must ANSWER):"; curl -sk -o /dev/null -w "%{http_code}\n" "https://$LAN_IP:8888/api/v1/health"
```
Expected: MCP answers on loopback, **refuses** on the LAN IP; the gateway answers on both. A LAN-reachable MCP is a defect — go back to Step 6.

- [ ] **Step 12: Verify `delegateTask` can now reach hermes**

The reason this whole migration exists:

```bash
sudo -u "$USER" /opt/sentient/current/bin/sentient-gateway --version 2>/dev/null || true
which hermes && hermes --help | head -3
```
Expected: the `hermes` binary resolves on the operator's `PATH`. Full end-to-end delegation is exercised in Task 8/9; this step only proves the binary is reachable from the gateway's environment.

- [ ] **Step 13: Commit**

```bash
git commit -m "feat(deploy): run the gateway natively under launchd with loopback-only addons" -- \
  gateway/config.yaml deploy/macos/docker-compose.yml deploy/mac-prod/docker-compose.yml \
  deploy/mac-prod/io.sentient.gateway.plist gateway/mcp/ gateway/Dockerfile deploy/hermes-overlay/
```
