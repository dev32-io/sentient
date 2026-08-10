### Task 4b: ingress-proxy — reach internal addons without breaking their egress boundary

**Wave 2 (addendum) · model: opus · resolves the escalated decision from Task 4**

**Files:**
- Create: `gateway/mcp/ingress-proxy/Dockerfile`, `gateway/mcp/ingress-proxy/nginx.conf` (or tinyproxy-equivalent, matching the egress-proxy pattern)
- Create: `gateway/templates/services/ingress-proxy.yaml`
- Modify: `gateway/config.yaml` (`managed_services.ingress-proxy`; revert fetch-mcp + searxng-mcp to internal-only)
- Modify: `gateway/templates/services/fetch-mcp.yaml`, `gateway/templates/services/searxng-mcp.yaml`
- Modify: `gateway/src/system-orchestrator/docker-driver.test.ts` (the guard's expectations)

---

**Why this exists.** Task 4 proved empirically (docker 29.2.1, via the CLI, not our code) that Docker **silently drops port publishing** when every attached network is `internal: true`:

```
--network sentient-internal -p 127.0.0.1:19991:8088  →  Ports={"8088/tcp":[]}
--network sentient-external -p 127.0.0.1:19991:8088  →  published, answered 406
```

It also ruled out the obvious shortcut: a non-internal bridge with `com.docker.network.bridge.enable_ip_masquerade=false` **still egressed** 200 to example.com on Docker Desktop.

So loopback publishing and network-enforced egress confinement are mutually exclusive *for a single container*. A fix agent resolved this by joining `fetch-mcp` to `sentient-external`, which made it reachable but downgraded its egress confinement from **network-enforced** to **env-advisory** (`HTTP_PROXY` only) — on the one addon whose entire job is fetching untrusted URLs.

**Operator decision (2026-07-29): preserve the boundary.** One container spans both networks so the MCPs never have to. This mirrors `egress-proxy` exactly, inverted.

```
native gateway ──► 127.0.0.1:8088 ─┐
                                   │  ingress-proxy
                                   │  (sentient-external + sentient-internal)
                                   └─► sentient-internal ──► fetch-mcp   (internal: true)
                                                         ──► searxng-mcp (internal: true)
```

`fetch-mcp` egress becomes physically impossible again, not merely discouraged.

---

- [ ] **Step 1: State probe**

```bash
git log --oneline -10
git status --short
grep -n "networks:" gateway/templates/services/fetch-mcp.yaml gateway/templates/services/searxng-mcp.yaml
ls gateway/mcp/ingress-proxy 2>/dev/null && echo "already started"
```
Report which step you are resuming at. Note the current (to-be-reverted) `sentient-external` joins.

- [ ] **Step 2: Read the egress-proxy pattern you are mirroring**

```bash
cat gateway/templates/services/egress-proxy.yaml
ls gateway/mcp/ 2>/dev/null; find . -name "tinyproxy.conf" -not -path "*/node_modules/*" | head
```
Match its structure, its config-seeding approach, and its comment style. Do not invent a new pattern.

- [ ] **Step 3: Write the failing test for the guard's new expectation**

`enforcePublishReachable` (added in `693d133`) refuses a publish when every attached network is internal. That stays — but `ingress-proxy` legitimately spans both, and the MCPs behind it must now publish **nothing**. Pin both halves in `gateway/src/system-orchestrator/docker-driver.test.ts`:

```ts
it("SECURITY: an internal-only service with NO ports is allowed (it sits behind ingress-proxy)", () => {
  // fetch-mcp's shape after this task: internal-only, no publish. The guard must
  // not reject it — it is only reachable via ingress-proxy, by design.
  const ms = dockerService("fetch-mcp", {
    networks: ["sentient-internal"],
    ports: [],
  });
  expect(enforcePublishReachableForTest(ms, { "sentient-internal": { internal: true } }).ok).toBe(true);
});

it("SECURITY: ingress-proxy may publish because it also attaches a non-internal network", () => {
  const ms = dockerService("ingress-proxy", {
    networks: ["sentient-internal", "sentient-external"],
    ports: ["127.0.0.1:8088:8088"],
  });
  const nets = { "sentient-internal": { internal: true }, "sentient-external": { internal: false } };
  expect(enforcePublishReachableForTest(ms, nets).ok).toBe(true);
});
```
Use the real helper name and fixture builders already in that file — read it first rather than assuming these names.

- [ ] **Step 4: Run and confirm the expected failures**

```bash
cd gateway/src && bun test system-orchestrator/docker-driver.test.ts
```
Expected: the ingress-proxy case may already pass (it attaches a non-internal network); the internal-only-no-ports case is the one that must be shown to hold. If both already pass, say so — the guard was written correctly and these are regression pins, not fixes. Record which.

- [ ] **Step 5: Build the ingress-proxy image**

`gateway/mcp/ingress-proxy/` — a minimal reverse proxy (nginx-alpine is the smallest sane choice) that listens on the addon ports and forwards to the internal service names. Pin the upstream image version, per the MCP deployment rule.

```nginx
# ingress-proxy: the ONLY container that spans sentient-external and
# sentient-internal. It exists so every MCP can keep `internal: true` —
# docker silently drops port publishing when all attached networks are
# internal, so without this the native gateway could not reach them at all.
# Inverse of egress-proxy: that one gates traffic OUT, this one lets it IN.
server {
  listen 8088;
  location / { proxy_pass http://sentient-fetch-mcp:8088; proxy_set_header Host $host; }
}
server {
  listen 8087;
  location / { proxy_pass http://sentient-searxng-mcp:8087; proxy_set_header Host $host; }
}
```

- [ ] **Step 6: Add the service template and registry entry**

`gateway/templates/services/ingress-proxy.yaml` — attaches BOTH networks, publishes both loopback ports, `depends_on` the services it fronts. Then `managed_services.ingress-proxy` in `gateway/config.yaml` with a `tcp` healthcheck on `127.0.0.1:8088` and `optional: false`.

- [ ] **Step 7: Revert the two MCPs to internal-only, no publish**

In `gateway/templates/services/fetch-mcp.yaml` and `searxng-mcp.yaml`: drop `sentient-external` from `networks`, delete the `ports:` block, and **replace the now-wrong comment** explaining why they no longer publish. Keep the `HTTP_PROXY`/`HTTPS_PROXY` env — belt and braces alongside the restored network enforcement.

- [ ] **Step 8: Repoint the gateway's URLs at the proxy**

The URLs in `gateway/config.yaml` stay `http://127.0.0.1:8088/mcp` and `http://127.0.0.1:8087/mcp` — the gateway is unaware anything changed. **Verify** rather than assume: they should need no edit.

```bash
grep -nE "127\.0\.0\.1:(8087|8088)" gateway/config.yaml
```

- [ ] **Step 9: Run the gate**

```bash
cd gateway/src && bun test
bun run --filter '*' typecheck
bunx biome check .
```
Expected: all green, pass count at or above 1220.

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(deploy): ingress-proxy so addons keep network-enforced egress confinement" -- \
  gateway/mcp/ingress-proxy/ gateway/templates/services/ \
  gateway/config.yaml gateway/src/system-orchestrator/docker-driver.test.ts
```

- [ ] **Step 11: Prove the boundary is actually restored — both directions**

This is the point of the whole task, so verify against the real daemon:

```bash
HOST_DOCKER_GID=0 docker compose -f deploy/macos/docker-compose.yml up -d
sleep 15

echo "-- gateway can reach fetch-mcp through the proxy (must ANSWER) --"
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8088/mcp

echo "-- fetch-mcp CANNOT egress directly (must FAIL: no route) --"
docker exec sentient-fetch-mcp sh -c 'unset HTTP_PROXY HTTPS_PROXY; curl -s -m 5 -o /dev/null -w "%{http_code}\n" https://example.com' \
  || echo "no route (expected — network-enforced confinement restored)"

echo "-- fetch-mcp networks (must be internal ONLY) --"
docker inspect sentient-fetch-mcp --format '{{json .NetworkSettings.Networks}}' | tr ',' '\n' | grep -o 'sentient-[a-z]*' | sort -u
```
Expected: the proxy answers; **the direct-egress attempt fails with the proxy env unset**; `fetch-mcp` shows `sentient-internal` only. The middle probe is the one that matters — it is the assertion the previous shape would have failed.

- [ ] **Step 12: Commit the evidence**

```bash
git commit -m "test(deploy): prove ingress reach without restoring addon egress" -- qa/native/
```
