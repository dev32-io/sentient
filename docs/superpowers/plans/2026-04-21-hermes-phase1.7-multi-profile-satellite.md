# Phase 1.7 — Multi-Profile + ESP32 Satellites + Cerebrum Flip

> **Parent plan:** `2026-04-21-hermes-phase1-overview.md`
> **Previous:** `2026-04-21-hermes-phase1.6-web-tools.md`

**Goal:** make the new Hermes-backed cerebrum actually serve real sessions. Land:

1. Full multi-user `SessionRouter` (Strategy A default per Phase 1.0 M-1; Strategy B fallback stubbed).
2. Device-identity registry for ESP32 satellites (deviceId → default user).
3. `identify_user` rebind fully wired end-to-end (MCP tool → router → session).
4. WS auth for satellite devices (extends existing auth).
5. Flip `cerebrum.provider` from `in-process` to `hermes` under a config flag.
6. AttentionGate calls the Hermes dispatcher instead of the old `runCognitiveCycle`.

**Builds on:** Phases 1.1–1.6 (schema, client, translator, dispatcher, TTS chain, gateway MCP, HA, web tools).

**Spec reference:** v4 §5.10, §5.11, §5.12, §5.13, §5.14, D-5, D-13.

---

## 1. Context and prerequisites

Before starting, confirm from Phase 1.0 measurements:
- **M-1 verdict:** PASS → Strategy A (always-on per user). FAIL → fallback to Strategy B eviction (implement stub only in Phase 1.7; full eviction is post-v1).
- **M-5 verdict:** ISOLATED → no per-profile mutex needed in HermesClient. CROSS-LEAK → add a simple per-userId async mutex around `dispatch()`.

Read `docs/superpowers/plans/notes/2026-04-21-phase1.0-measurements.md` for actual values.

### Bootstrap flow we're enabling

1. User opens webui OR satellite device connects WS.
2. Gateway authenticates connection → resolves `userId` (from device registry OR existing web auth).
3. `SessionRouter.bind(sessionId, userId)` → returns `HermesProfileBinding`.
4. First user message → AttentionGate fires → `dispatchHermesCycle(...)` with the binding.
5. Hermes container for that user processes the turn; response flows back via HermesClient → translator → wire messages.
6. User says "I am Bob" → Hermes calls `identify_user` MCP → gateway rebinds → next turn goes to Bob's Hermes container.

---

## Task 1.7.1 — Multi-user SessionRouter

**Files:**
- Modify: `gateway/src/session-router.ts`
- Modify: `gateway/src/session-router.test.ts`

### Step 1.7.1a: Real multi-user implementation

Replace Phase 1.1's single-user stub:

- [ ] Edit `gateway/src/session-router.ts`. Change `resolveProfile` to actually look up by `userId`:

```typescript
function resolveProfile(userId: string | null): HermesProfileBinding {
  const effectiveUserId = userId ?? defaultUserId();
  const profile = config.profiles[effectiveUserId];
  if (!profile || !profile.enabled || profile.role !== "user") {
    throw new Error(
      `no enabled user profile for userId=${effectiveUserId}; check hermes.profiles in config`,
    );
  }
  return {
    userId: effectiveUserId,
    url: profile.url,
    apiKey: apiKeyResolver(profile.api_key_env),
    conversationId: null,
  };
}

function defaultUserId(): string {
  const first = Object.entries(config.profiles)
    .filter(([id, p]) => !id.startsWith("_") && p.enabled && p.role === "user")
    .at(0);
  if (!first) throw new Error("no default user profile");
  return first[0];
}
```

- [ ] Add conversationId persistence across turns. Update the `bind` path so binding is reused per session, and expose a `updateConversationId` method:

```typescript
export interface SessionRouter {
  bind(sessionId: string, userId: string | null): HermesProfileBinding;
  release(sessionId: string): void;
  rebind(sessionId: string, newUserId: string): HermesProfileBinding;
  get(sessionId: string): HermesProfileBinding | null;
  /** Called by HermesClient/dispatcher after a turn captures a new conversation id. */
  updateConversationId(sessionId: string, conversationId: string): void;
}
```

- [ ] Implement `updateConversationId`: look up the internal binding, mutate conversationId. The value is mutable per v4 spec.

### Step 1.7.1b: Tests

- [ ] Extend `gateway/src/session-router.test.ts` with multi-user cases:

```typescript
it("resolves bob profile when userId=bob", () => {
  const config = {
    ...baseConfig,
    profiles: {
      alice: { ...baseConfig.profiles.alice },
      bob: {
        container_name: "hermes-bob",
        port: 8644,
        api_key_env: "HERMES_API_KEY_BOB",
        url: "http://hermes-bob:8644",
        profile_dir: "./profiles/bob",
        role: "user" as const,
        enabled: true,
      },
    },
  };
  const router = createSessionRouter(config, fakeResolver);
  const b = router.bind("sess-1", "bob");
  expect(b.userId).toBe("bob");
  expect(b.url).toBe("http://hermes-bob:8644");
});

it("updateConversationId mutates the stored binding", () => {
  const router = createSessionRouter(baseConfig, fakeResolver);
  router.bind("sess-1", "alice");
  router.updateConversationId("sess-1", "conv-xyz");
  expect(router.get("sess-1")?.conversationId).toBe("conv-xyz");
});

it("rebind to different user resets conversationId", () => {
  const config = /* with alice + bob */;
  const router = createSessionRouter(config, fakeResolver);
  router.bind("sess-1", "alice");
  router.updateConversationId("sess-1", "conv-alice");
  router.rebind("sess-1", "bob");
  expect(router.get("sess-1")?.userId).toBe("bob");
  expect(router.get("sess-1")?.conversationId).toBeNull();
});
```

### Step 1.7.1c: Verify + commit

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- session-router
git add gateway/src/session-router.ts gateway/src/session-router.test.ts
git commit -m "$(cat <<'EOF'
feat(gateway): multi-user SessionRouter with conversation persistence

Resolves Hermes profile by userId. Adds updateConversationId so
HermesDispatcher can persist session continuity across turns. Rebind
resets conversationId (new user = fresh context).

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.7.2 — Add bob + family profiles

**Files:**
- Modify: `gateway/config.yaml`
- Create: `profiles/bob/config.yaml`
- Create: `profiles/bob/SOUL.md`
- Create: `profiles/bob/.env.example`
- Create: `profiles/family/config.yaml`
- Create: `profiles/family/SOUL.md`
- Create: `profiles/family/.env.example`
- Create: `deploy/docker/secrets/hermes_api_key_bob.example`
- Create: `deploy/docker/secrets/hermes_api_key_family.example`
- Modify: `deploy/docker/docker-compose.yml`

### Step 1.7.2a: Render profiles from templates

```bash
# Bob
mkdir -p profiles/bob
sed -e "s/{{USER_NAME}}/bob/g" -e "s/{{RENDERED_AT}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" gateway/templates/hermes-profile.yaml.tmpl > profiles/bob/config.yaml
sed -e "s/{{USER_NAME}}/Bob/g" -e "s/{{RENDERED_AT}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" gateway/templates/SOUL.md.tmpl > profiles/bob/SOUL.md
cp profiles/alice/.env.example profiles/bob/.env.example

# Family (shared profile for public devices like kitchen/living room)
mkdir -p profiles/family
sed -e "s/{{USER_NAME}}/family/g" -e "s/{{RENDERED_AT}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" gateway/templates/hermes-profile.yaml.tmpl > profiles/family/config.yaml
sed -e "s/{{USER_NAME}}/the family/g" -e "s/{{RENDERED_AT}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" gateway/templates/SOUL.md.tmpl > profiles/family/SOUL.md
cp profiles/alice/.env.example profiles/family/.env.example
```

### Step 1.7.2b: Add profiles to `hermes.profiles` in config.yaml

- [ ] Open `gateway/config.yaml` and under `hermes.profiles` add:

```yaml
    bob:
      container_name: hermes-bob
      port: 8644
      api_key_env: HERMES_API_KEY_BOB
      url: "http://hermes-bob:8644"
      profile_dir: "./profiles/bob"
      role: user
      enabled: true
    family:
      container_name: hermes-family
      port: 8645
      api_key_env: HERMES_API_KEY_FAMILY
      url: "http://hermes-family:8645"
      profile_dir: "./profiles/family"
      role: user
      enabled: true
```

### Step 1.7.2c: Secrets

```bash
openssl rand -hex 32 > deploy/docker/secrets/hermes_api_key_bob
openssl rand -hex 32 > deploy/docker/secrets/hermes_api_key_family
chmod 600 deploy/docker/secrets/hermes_api_key_*
cp deploy/docker/secrets/hermes_api_key_alice.example deploy/docker/secrets/hermes_api_key_bob.example
cp deploy/docker/secrets/hermes_api_key_alice.example deploy/docker/secrets/hermes_api_key_family.example
```

Add to `secrets:` block in compose:

```yaml
secrets:
  hermes_api_key_bob: { file: ./secrets/hermes_api_key_bob }
  hermes_api_key_family: { file: ./secrets/hermes_api_key_family }
```

### Step 1.7.2d: Docker services

- [ ] Add `hermes-bob` and `hermes-family` to `deploy/docker/docker-compose.yml`. Copy the `hermes-alice` block, change:
  - service name: `hermes-bob` / `hermes-family`
  - ports: 8644 / 8645
  - volumes source: `../../profiles/bob` / `../../profiles/family`
  - API_SERVER_KEY_FILE target: `/run/secrets/hermes_api_key_bob` / `_family`
  - secrets: reference the right secret
  - env_file: `../../profiles/bob/.env` / `_family`

### Step 1.7.2e: Smoke boot

```bash
cd deploy/docker && docker compose up -d && cd ../..
docker ps --filter "name=hermes-" --format "table {{.Names}}\t{{.Status}}"
# Expect 3 containers healthy
cd deploy/docker && docker compose down && cd ../..
```

### Step 1.7.2f: Commit

```bash
git add profiles/bob/ profiles/family/ gateway/config.yaml deploy/docker/docker-compose.yml deploy/docker/secrets/*.example
git commit -m "$(cat <<'EOF'
feat(profiles): bob + family profiles; docker services

Three user profiles now. Alice + Bob are per-person; family is the
shared profile for public devices (kitchen, living room).

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.7.3 — Device-identity registry

**Files:**
- Create: `gateway/src/sensors/satellite-device-registry.ts`
- Create: `gateway/src/sensors/satellite-device-registry.test.ts`
- Create: `shared/config/src/schemas/satellite-devices.ts`
- Modify: `shared/config/src/schemas/index.ts`
- Modify: `gateway/config.yaml` (add `hermes.satellite_devices`)

### Step 1.7.3a: Config schema

- [ ] Create `shared/config/src/schemas/satellite-devices.ts`:

```typescript
import { z } from "zod";

export const satelliteDeviceSchema = z.object({
  device_id: z.string().min(1),
  default_user: z.string().min(1),
  location: z.string().min(1),
  speak_voice: z.string().min(1),
});
export type SatelliteDevice = z.infer<typeof satelliteDeviceSchema>;

export const satelliteDevicesSchema = z.array(satelliteDeviceSchema).default([]);
```

- [ ] Re-export from `shared/config/src/schemas/index.ts`.

- [ ] Extend `hermesConfigSchema` in `shared/config/src/schemas/hermes-config.ts`:

```typescript
import { satelliteDevicesSchema } from "./satellite-devices";

export const hermesConfigSchema = z.object({
  // ...existing...
  satellite_devices: satelliteDevicesSchema,
});
```

### Step 1.7.3b: Registry

- [ ] Create `gateway/src/sensors/satellite-device-registry.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import type { SatelliteDevice } from "@sentient/config/schemas";

const log = createLogger(["sentient.gateway.sensors", "satellite-device-registry"]);

export interface SatelliteDeviceRegistry {
  resolve(deviceId: string): SatelliteDevice | null;
  list(): readonly SatelliteDevice[];
}

export function createSatelliteDeviceRegistry(
  devices: SatelliteDevice[],
): SatelliteDeviceRegistry {
  const byId = new Map(devices.map((d) => [d.device_id, d]));
  log.debug("init", { count: devices.length });
  return {
    resolve(deviceId) {
      return byId.get(deviceId) ?? null;
    },
    list() {
      return devices;
    },
  };
}
```

### Step 1.7.3c: Tests

- [ ] Create `gateway/src/sensors/satellite-device-registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createSatelliteDeviceRegistry } from "./satellite-device-registry";

const devices = [
  {
    device_id: "sat-kitchen-001",
    default_user: "family",
    location: "kitchen",
    speak_voice: "fish_family_default",
  },
  {
    device_id: "sat-alice-bed-002",
    default_user: "alice",
    location: "alice-bed",
    speak_voice: "fish_alice",
  },
];

describe("SatelliteDeviceRegistry", () => {
  it("resolves by device id", () => {
    const r = createSatelliteDeviceRegistry(devices);
    expect(r.resolve("sat-kitchen-001")?.default_user).toBe("family");
    expect(r.resolve("unknown")).toBeNull();
  });

  it("list returns all", () => {
    const r = createSatelliteDeviceRegistry(devices);
    expect(r.list()).toHaveLength(2);
  });
});
```

### Step 1.7.3d: Config yaml

- [ ] In `gateway/config.yaml` under `hermes:`, add:

```yaml
  satellite_devices:
    - device_id: "sat-kitchen-001"
      default_user: family
      location: kitchen
      speak_voice: fish_family_default
    - device_id: "sat-alice-bed-002"
      default_user: alice
      location: alice-bed
      speak_voice: fish_alice
```

(Real devices will be provisioned later; these are stubs for testing.)

### Step 1.7.3e: Commit

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- satellite-device-registry
git add shared/config/src/schemas/satellite-devices.ts shared/config/src/schemas/index.ts shared/config/src/schemas/hermes-config.ts gateway/src/sensors/satellite-device-registry.ts gateway/src/sensors/satellite-device-registry.test.ts gateway/config.yaml
git commit -m "$(cat <<'EOF'
feat(sensors): satellite device registry

Maps deviceId → default user, location, TTS voice. Gateway resolves at
WS connect time to auto-bind a session to the right Hermes profile.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.7.4 — Device-aware WS auth

**Files:**
- Modify: `gateway/src/auth/` (existing auth logic — adapt)

### Step 1.7.4a: Extend auth to accept device identity

Each ESP32 sends `deviceId` + `deviceSecret` on WS connect. Gateway:
1. Looks up device in registry.
2. If `deviceSecret` matches expected (stored in secrets), binds to `default_user`.
3. Otherwise rejects.

The EXISTING auth implementation shape varies. Broadly:

- [ ] Find the auth entry point:

```bash
grep -lrn "auth.*ws\|validateAuth\|createAuth" gateway/src/auth/ gateway/src/session-handlers/ | head
```

- [ ] Extend the auth payload schema to allow an optional `device` block:

```typescript
export const wsAuthSchema = z.object({
  // ...existing fields...
  device: z.object({
    deviceId: z.string(),
    deviceSecret: z.string(),
  }).optional(),
});
```

- [ ] In the auth handler:

```typescript
if (authPayload.device) {
  const dev = deviceRegistry.resolve(authPayload.device.deviceId);
  if (!dev) return { ok: false, reason: "unknown_device" };
  // Compare device secret against stored value — implementation depends on
  // where secrets live. Simplest: a bcrypt-hashed map in config, or a shared
  // signing token. For POC, accept any non-empty secret matching a config stub
  // per device.
  if (!verifyDeviceSecret(dev.device_id, authPayload.device.deviceSecret)) {
    return { ok: false, reason: "bad_device_secret" };
  }
  return { ok: true, userId: dev.default_user, role: "user" };
}
```

- [ ] For Phase 1.7 POC, `verifyDeviceSecret` can be a shared HMAC: the device sends `HMAC-SHA256(deviceId, sharedSecret)`; gateway recomputes and compares. Keep it simple.

### Step 1.7.4b: Tests

- [ ] Add auth tests covering device-bound sessions AND rejection on unknown device / bad secret. Follow existing test patterns in the repo.

### Step 1.7.4c: Commit

```bash
git add gateway/src/auth/
git commit -m "$(cat <<'EOF'
feat(auth): accept ESP32 device identity on WS connect

Extends auth payload to carry deviceId + deviceSecret. Verifies against
device registry. Binds the resolved session to the device's default_user.
For POC, HMAC-SHA256 shared-secret verification; Phase 2+ moves to per-
device certificates.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.7.5 — Wire identify_user MCP to SessionRouter

**Files:**
- Modify: `gateway/src/mcp-host/tools/identify-user.ts`
- Modify: gateway entry point — pass a real `sessionForConnection` resolver.

### Step 1.7.5a: Per-connection session map

The MCP server has a pool of Unix socket connections. Each Hermes container maintains ONE connection; its MCP calls all come from that connection. To map MCP `connectionId` → gateway `sessionId`, we need an initial handshake.

Simplest approach: when gateway starts an MCP connection, it sends a notification with the Hermes profile id. We associate that connection with all sessions bound to that userId. BUT — multiple sessions can be bound to the same userId (e.g., both webui and satellite for alice). Disambiguation: use a SPECIAL first tool call to establish the association.

A cleaner approach for Phase 1.7: piggyback on `identify_user` itself. Hermes reads the user message and determines it should call `identify_user`; the tool's handler receives the MCP `connectionId` (which identifies the Hermes container → the userId). From userId, we look up all active session bindings with that userId; if exactly one, that's our session; if ambiguous, pick the most recent.

- [ ] Modify `gateway/src/mcp-host/tools/identify-user.ts`:

```typescript
export interface IdentifyUserDeps {
  router: SessionRouter;
  config: HermesConfig;
  /**
   * Resolves sessionId given MCP ctx. The ctx is scoped by connection; we
   * translate connection → current userId → active sessionId.
   */
  resolveSessionByContext(ctx: ToolContext): string | null;
}
```

- [ ] The resolver lives in gateway entry point. Map `connectionId → userId` established at MCP connect handshake (new concept), and then `userId → latest session` via the router.

### Step 1.7.5b: Connect-time handshake

- [ ] Update the MCP protocol `initialize` handler to accept a `clientInfo.userId` field. Hermes sends it in its MCP initialize. Cache `connectionId → userId`.

- [ ] Modify `mcp-server.ts` to receive an `onInitialize` callback:

```typescript
export interface McpServerDeps {
  registry: ToolRegistry;
  contextFor(connectionId: string): ToolContext;
  onInitialize?(connectionId: string, clientInfo: unknown): void;
}

// In handleRpc initialize case:
if (req.method === "initialize") {
  const params = req.params as { clientInfo?: unknown } | undefined;
  if (params?.clientInfo) deps.onInitialize?.(id === null ? "" : String(id), params.clientInfo);
  // ...existing response...
}
```

Actually — a simpler approach. Inside each Hermes container, we set an env var `HERMES_PROFILE_USER_ID=alice`. Then configure the gateway MCP entry in profile config to pass it:

```yaml
mcp_servers:
  gateway:
    command: nc
    args: ["-U", "/run/sentient/mcp.sock"]
    env:
      HERMES_PROFILE_USER_ID: "${HERMES_PROFILE_USER_ID}"
```

But MCP server doesn't see client env. Cleanest Phase 1.7 approach: since each Hermes container is per-user, ADD a per-container shim script that prefixes requests with a `userId` header. OR send an `initialize` notification right after connect.

**Pragmatic Phase 1.7 choice:** use a per-user Unix socket path. Gateway listens on `/run/sentient/mcp-alice.sock`, `/run/sentient/mcp-bob.sock`, etc. The connection path itself is the userId.

- [ ] Update `gateway/src/mcp-host/unix-socket-listener.ts` to accept a `userId` param and pass it via `contextFor`:

```typescript
export function createUnixSocketListener(
  socketPath: string,
  userId: string,
  deps: McpServerDeps,
): UnixSocketListener {
  // same code, but on connect, store userId in socket.data
  // contextFor gets userId from socket.data instead of connectionId lookup
}
```

- [ ] Gateway startup now creates ONE listener per user profile:

```typescript
for (const [userId, profile] of Object.entries(config.hermes!.profiles)) {
  if (!profile.enabled || profile.role !== "user") continue;
  const socketPath = `/run/sentient/mcp-${userId}.sock`;
  const listener = createUnixSocketListener(socketPath, userId, { registry, contextFor: (_conn) => ({ sessionId: null, userId }) });
  await listener.start();
  listeners.push(listener);
}
```

- [ ] Update profile template to point at user-specific socket:

```yaml
mcp_servers:
  gateway:
    command: nc
    args: ["-U", "/run/sentient/mcp-{{USER_NAME}}.sock"]
    # ... tools.include as before ...
```

- [ ] Re-render alice/bob/family profiles.

### Step 1.7.5c: Use userId + router to resolve session

- [ ] In `identify-user.ts` handler, the `ctx.userId` is now populated. For session lookup:

```typescript
async run(args, ctx) {
  // ... validate name ...
  // ctx.userId is the CURRENT user of the Hermes container making this call
  // SessionRouter.findActiveSessionFor(userId) returns the most recent active sessionId
  const sessionId = deps.router.findActiveSessionFor(ctx.userId ?? "");
  if (!sessionId) { /* advisory success */ }
  deps.router.rebind(sessionId, rawName);
  // ...
}
```

- [ ] Add `findActiveSessionFor(userId)` to `SessionRouter`: scans bindings, returns most recent sessionId bound to that userId, or null.

### Step 1.7.5d: Tests

- [ ] Add test: call `identify_user` via MCP (with the Unix socket listener already stood up), verify the rebind lands in `SessionRouter`. Can be an integration-style test that uses a `net.connect` client against a temp socket.

### Step 1.7.5e: Commit

```bash
git add gateway/src/ gateway/templates/ profiles/
git commit -m "$(cat <<'EOF'
feat(mcp-host): per-user Unix sockets; identify_user end-to-end

Gateway hosts one MCP listener per enabled user profile, each on a
distinct socket path mcp-<user>.sock. Profile templates point Hermes
at its own socket. MCP ToolContext carries userId reliably. identify_user
calls SessionRouter.findActiveSessionFor(userId) to locate the session to
rebind.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.7.6 — AttentionGate cutover to Hermes

**Files:**
- Modify: `gateway/src/cerebrum/attention-gate.ts` (or wherever `onCycle` is called)

### Step 1.7.6a: Feature-flag dispatch

- [ ] Find where AttentionGate calls `runCognitiveCycle` today:

```bash
grep -n "runCognitiveCycle\|onCycle" gateway/src/cerebrum/attention-gate.ts
```

- [ ] Add the Hermes branch gated on `config.cerebrum.provider`:

```typescript
async function onCycle(params: OnCycleParams): Promise<CycleOutcome> {
  if (config.cerebrum.provider === "hermes") {
    return runHermesCycle(params, deps);
  }
  return runInProcessCycle(params, deps); // existing path
}

async function runHermesCycle(
  params: OnCycleParams,
  deps: CycleDeps,
): Promise<CycleOutcome> {
  const binding = deps.sessionRouter.get(params.sessionId);
  if (!binding) {
    deps.emit({ type: "error", message: "no binding for session", code: "no_binding" });
    return { aborted: true, shouldContinue: false };
  }
  const { conversationId } = await dispatchHermesCycle(
    {
      sessionId: params.sessionId,
      userId: binding.userId,
      cycleId: params.cycleId,
      userMessage: params.userMessage,
      binding,
      maxOutputTokens: config.hermes!.defaults.max_output_tokens,
      signal: params.signal,
      mode: { bargedIn: () => deps.audioState.isBargedIn(params.sessionId) },
    },
    {
      clientFor: (b) => new HttpHermesClient(b),
      mirror: deps.conversationMirror,
      tasks: deps.taskMirror,
      emit: deps.emit,
      startTts: (deltas, cycleId) => deps.tts.run(deltas, cycleId),
    },
  );
  if (conversationId) deps.sessionRouter.updateConversationId(params.sessionId, conversationId);
  return { aborted: false, shouldContinue: false };
}
```

### Step 1.7.6b: Flip the flag for dev

- [ ] In `gateway/config.yaml`, change:

```yaml
cerebrum:
  provider: hermes
```

- [ ] Gate this behind an env-var override for local testing:

```yaml
cerebrum:
  provider: "${CEREBRUM_PROVIDER:-in-process}"
```

If the config loader supports defaults, set `CEREBRUM_PROVIDER=hermes` only in dev/pi deploys. Keep in-process fallback path intact until Phase 1.9 deletion.

### Step 1.7.6c: Smoke test end-to-end

- [ ] Build + boot:

```bash
cd deploy/docker/hermes && docker build -f Dockerfile.slim -t sentient-hermes:slim . && cd ../..
cd deploy/docker && docker compose up -d && cd ../..
```

- [ ] Export the flag and start the gateway dev server:

```bash
export CEREBRUM_PROVIDER=hermes
source scripts/env.sh && bun run dev
```

- [ ] Open the webui, authenticate as Alice (however dev auth currently works), say "hi" (voice or text).
- [ ] Expect: typewriter renders Alice's Hermes response; audio speaks; wire events show `cycle.started` → `message.delta` → `cycle.completed`.
- [ ] Try "I am Bob." — expect `identify_user` tool call, then a rebind; next turn goes to Bob's Hermes.
- [ ] Try "turn on the living room lights" — expect HA MCP tool call (if HA_MCP_TOKEN + HA Expose are set up).
- [ ] Try "what's the capital of France?" — expect web search tool call.

### Step 1.7.6d: Commit

```bash
git add gateway/src/cerebrum/attention-gate.ts gateway/config.yaml
git commit -m "$(cat <<'EOF'
feat(cerebrum): AttentionGate dispatches via Hermes when provider=hermes

Adds runHermesCycle branch. Old runInProcessCycle kept for fallback.
cerebrum.provider feature-flagged via env. Bindings resolved from
SessionRouter; conversationId persisted after each turn. TTS pipeline
wired via startTts hook; barge-in queried via audioState.isBargedIn.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.7.7 — Strategy B stub (graceful degradation)

For POC we default to Strategy A (always-on). Strategy B (on-demand pause/unpause) is fallback — implement enough so gateway can tolerate RAM pressure without crashing, but full eviction logic ships post-v1.

**Files:**
- Create: `gateway/src/session-router-strategy-b.ts` (stub)
- Create: `gateway/src/session-router-strategy-b.test.ts` (smoke)

### Step 1.7.7a: Stub

- [ ] Create a minimal function `pauseIdleProfiles()` that logs "would pause X" but doesn't actually invoke Docker APIs yet. Full implementation is a follow-up:

```typescript
import { createLogger } from "@sentient/logging";

const log = createLogger(["sentient.gateway", "strategy-b"]);

export function pauseIdleProfiles(now: number, bindings: ReadonlyArray<{ userId: string; lastActiveAtMs: number }>, idleAfterMs: number): string[] {
  const stale = bindings
    .filter((b) => now - b.lastActiveAtMs > idleAfterMs)
    .map((b) => b.userId);
  if (stale.length > 0) log.debug("would-pause", { stale });
  return stale;
}
```

### Step 1.7.7b: Commit

```bash
source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- strategy-b
git add gateway/src/session-router-strategy-b.ts gateway/src/session-router-strategy-b.test.ts
git commit -m "$(cat <<'EOF'
chore(gateway): Strategy B stub (on-demand eviction) for future use

Returns list of userIds that would be paused under idle timeout. Actual
docker pause/unpause and RAM-pressure trigger ship post-v1 when M-1
demands it.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.7.8 — Quality gate

- [ ] Full CI: `source scripts/env.sh && bun run ci`
- [ ] Manual end-to-end with all three Hermes profiles running.

---

## Done

Phase 1.7 complete when:

- [ ] Multi-user `SessionRouter` + `updateConversationId`.
- [ ] Bob + family profiles rendered and running.
- [ ] Device registry + device-aware WS auth.
- [ ] Per-user Unix socket MCP listeners (gateway MCP per profile).
- [ ] `identify_user` end-to-end rebind.
- [ ] `cerebrum.provider: hermes` branch dispatches through `HermesClient`.
- [ ] Strategy B stub committed.
- [ ] Manual smoke test: voice in → Hermes reasoning → HA/web tools → voice out, identity rebind works, per-profile isolation holds.
- [ ] `bun run ci` green.

**Proceed to** `2026-04-21-hermes-phase1.8-security.md`.
