# Inbound Proxy, Web Serving, and One-Command Launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the stack one outward-facing door — `https://<host>` reaches the web UI in dev and prod alike — and one command that brings the whole local stack up.

**Architecture:** A stock-nginx `inbound-proxy` container owns host 80/443 and proxies to the gateway on host loopback `:8888`. It is an orchestrator-managed addon in a new **infra service class** (applied before bootstrap, never given up on, not recreated when unchanged and healthy). The gateway moves from `0.0.0.0` to `127.0.0.1` and finally serves the built web UI. `bun run dev` becomes `scripts/stack.sh up` — preflight, build, launch, readiness, one printed URL.

**Tech Stack:** Bun + TypeScript (strict), zod, dockerode, nginx 1.30-alpine, bash, Python 3 (`setup-prod.py`), Kotlin (Android), Swift (iOS).

**Spec:** `docs/superpowers/specs/2026-08-04-inbound-proxy-and-web-serving-design.md`

## Global Constraints

- Every tunable constant lives in `gateway/config.yaml` with an inline comment. No magic numbers in source. (`.claude/rules/config.md`)
- Every new file imports a tagged logger via `getLog([...])`. No bare `console.*`. Tag reflects position in the hierarchy. (`.claude/rules/logging.md`)
- Explicit return types on all exported functions. `unknown` for external input, narrowed with zod. (`.claude/rules/gateway/bun-typescript.md`)
- Failable operations return `Result<T, E>` from `@sentient/protocol`. Never throw from business logic. (`.claude/rules/error-handling.md`)
- Tests only for: wire/protocol contract at a process boundary, FSM/invariant with a documented learning, security boundary, or `@live` flow. Do NOT test DI plumbing, constants, or internal collaborators. (`.claude/rules/testing.md`)
- Run `source scripts/env.sh` before any `bun` command.
- Gateway unit tests run with `cd gateway/src && bun test`. Root quality gate is `bun run ci`.
- Work on the current branch `feature/native-orchestrator`. Never push to `main` or `develop`.
- Commit format: `type(scope): description`. One logical change per commit.

## Plan-level decisions (spec §7)

These were left open by the spec and are decided here. Do not re-litigate during execution.

| Spec question | Decision |
|---|---|
| §7.1 Cert dir config shape | One nullable key `inbound_proxy.cert_dir`. Resolved once in `phase-orchestrator.ts`: use it if the directory exists, else fall back to `tls.certsDir`. Injected into `hostEnv` as `INBOUND_CERT_DIR` so the template's bind mount reads it like every other host path. |
| §7.2 Spec-hash contents | SHA-256 over `JSON.stringify` of the exact `buildCreateSpec()` output with the `Labels` key removed. Hash what we send to `createContainer` — nothing more, nothing less. `Labels` is excluded because the hash lives inside it. |
| §7.3 Readiness budgets | `stack_readiness_timeout_ms: 60000`, `stack_readiness_poll_ms: 500`, both in `config.yaml`. If loopback health passes but 443 does not, print both results and exit 1. |
| §7.4 Where the image lives | `gateway/addons/inbound-proxy/` (Dockerfile + nginx.conf). "Addon" is the project's own word for these. Template at `gateway/templates/services/inbound-proxy.yaml`, build entry in `deploy/mac-prod/docker-compose.yml`. |
| §7.5 `stack:status` | Probes independently. It is most wanted when the gateway is down, which is exactly when reading the orchestrator's status endpoint fails. |

## File structure

**Create:**

| Path | Responsibility |
|---|---|
| `gateway/addons/inbound-proxy/Dockerfile` | Stock `nginx:1.30-alpine` + one `COPY` + `RUN nginx -t` |
| `gateway/addons/inbound-proxy/nginx.conf` | The public routing table: 8080 redirect, 8443 TLS terminate, upstream verify, WS upgrade |
| `gateway/templates/services/inbound-proxy.yaml` | Container template — image, ports, volumes, networks |
| `gateway/src/system-orchestrator/spec-hash.ts` | `computeSpecHash()` — one pure function, its own file |
| `scripts/stack.sh` | The launcher: preflight → build → start → readiness → print |

**Modify:**

| Path | Change |
|---|---|
| `gateway/src/config/asset-root.ts` | Add `resolveWebDistDir()` handling both deployment shapes |
| `gateway/src/config/startup-config.ts:176` | `webDistDir` from the asset root, env as override |
| `gateway/src/config/operator-config-migrator.ts` | Add the 0.1.3 → 0.1.4 step (`host` → loopback) |
| `shared/tls/src/tls.ts` | `chmod` `key.pem` to 0600 |
| `gateway/src/system-orchestrator/types.ts` | `sentient-edge` network; `infra` + `public_ports` config fields; `PUBLIC_PORT_RE`; port schema union |
| `gateway/src/system-orchestrator/template-loader.ts` | Thread `allowPublicPorts` into `enforceLoopbackPorts` |
| `gateway/src/system-orchestrator/service-registry.ts` | Pass `cfg.public_ports` into `loadServiceTemplate` |
| `gateway/src/system-orchestrator/docker-driver.ts` | Public-port publishing; spec-hash label; skip-unchanged for infra |
| `gateway/src/system-orchestrator/health-watch.ts` | `neverGiveUp` predicate |
| `gateway/src/system-orchestrator/index.ts` | Wire `neverGiveUp`; add `reconcileInfraOnly()` |
| `gateway/src/bootstrap/phase-orchestrator.ts` | Resolve `INBOUND_CERT_DIR`; infra-only apply when bootstrap incomplete |
| `gateway/config.yaml` | `host`, `inbound_proxy`, `stack` block, `managed_services.inbound-proxy` |
| `shared/config/src/schema.ts` | Schema for the two new config blocks |
| `deploy/mac-prod/docker-compose.yml` | `inbound-proxy` build-only entry |
| `deploy/mac-prod/setup-prod.py` | Health gate through 443 |
| `package.json` | `dev`, `stack:down`, `stack:status` |
| `android/src/main/kotlin/io/sentient/android/backend/BackendSetupViewModel.kt:28` | `DEFAULT_PORT = 443` |
| `ios/App/SDK/GatewayConfig.swift:16` | default URL → 443 |
| `CLAUDE.md`, `deploy/README.md`, `gateway/CLAUDE.md` | Doc reconciliation |

---

### Task 1: Serve the built web UI from the asset root

Closes spec §1.2 / §4.1. Today `WEB_DIST_DIR` is set nowhere, so the static handler returns `null` for every request and prod has no UI on any port.

**Files:**
- Modify: `gateway/src/config/asset-root.ts`
- Modify: `gateway/src/config/startup-config.ts:176`
- Test: `gateway/src/config/asset-root.test.ts`

**Interfaces:**
- Consumes: `resolveAssetRoot()` (existing, same file)
- Produces: `resolveWebDistDir(): string | undefined` — absolute path to the directory holding `index.html`, or `undefined` when no built bundle exists.

- [ ] **Step 1: Write the failing test**

Create `gateway/src/config/asset-root.test.ts` (if it exists, append these cases):

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetAssetRootForTest, resolveWebDistDir } from "./asset-root.ts";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "asset-root-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  return root;
}

afterEach(() => {
  resetAssetRootForTest();
  delete process.env.GATEWAY_RUNTIME_DIR;
  delete process.env.WEB_DIST_DIR;
});

describe("resolveWebDistDir", () => {
  it("returns <root>/webui when that directory holds index.html (installed release)", () => {
    const root = makeRoot();
    mkdirSync(join(root, "webui"), { recursive: true });
    writeFileSync(join(root, "webui", "index.html"), "<html></html>");
    process.env.GATEWAY_RUNTIME_DIR = root;

    expect(resolveWebDistDir()).toBe(join(root, "webui"));
  });

  it("returns <root>/webui/dist when webui/ is a source tree (repo checkout)", () => {
    const root = makeRoot();
    mkdirSync(join(root, "webui", "dist"), { recursive: true });
    writeFileSync(join(root, "webui", "dist", "index.html"), "<html></html>");
    process.env.GATEWAY_RUNTIME_DIR = root;

    expect(resolveWebDistDir()).toBe(join(root, "webui", "dist"));
  });

  it("returns undefined when no bundle has been built", () => {
    const root = makeRoot();
    mkdirSync(join(root, "webui"), { recursive: true });
    process.env.GATEWAY_RUNTIME_DIR = root;

    expect(resolveWebDistDir()).toBeUndefined();
  });

  it("prefers WEB_DIST_DIR over the asset root when set", () => {
    const root = makeRoot();
    const override = mkdtempSync(join(tmpdir(), "web-override-"));
    writeFileSync(join(override, "index.html"), "<html></html>");
    process.env.GATEWAY_RUNTIME_DIR = root;
    process.env.WEB_DIST_DIR = override;

    expect(resolveWebDistDir()).toBe(override);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/env.sh && cd gateway/src && bun test config/asset-root.test.ts`
Expected: FAIL — `resolveWebDistDir` is not exported from `./asset-root.ts`.

- [ ] **Step 3: Implement `resolveWebDistDir`**

Append to `gateway/src/config/asset-root.ts`:

```ts
/** Where the BUILT web bundle lives, or undefined when nothing has been built.
 *
 *  Two shapes, and they differ by one path segment — which is exactly why the
 *  naive `assetPath("webui")` is wrong:
 *
 *    installed release — share/webui/index.html      (build-gateway.sh copies
 *                                                     webui/dist -> share/webui)
 *    repo checkout     — gateway/webui/dist/index.html  (webui/ is SOURCE here)
 *
 *  Probing for index.html rather than branching on "am I compiled" keeps the two
 *  shapes from needing a flag that could be wrong. `WEB_DIST_DIR` stays as an
 *  override for operators pointing at a bundle outside either layout.
 *
 *  Returns undefined rather than throwing: a gateway with no UI still serves the
 *  API, and the launcher builds the bundle before start (scripts/stack.sh). */
export function resolveWebDistDir(): string | undefined {
  const override = process.env.WEB_DIST_DIR;
  if (override !== undefined && override.length > 0) {
    log.debug("web-dist.resolved", { dir: override, reason: "WEB_DIST_DIR" });
    return override;
  }
  const root = resolveAssetRoot();
  const candidates = [join(root, "webui"), join(root, "webui", "dist")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) {
      log.debug("web-dist.resolved", { dir, reason: "asset-root" });
      return dir;
    }
  }
  log.warn("web-dist.unresolved", {
    reason: "no index.html under <asset-root>/webui or <asset-root>/webui/dist — the UI will 404",
    candidates,
  });
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `source scripts/env.sh && cd gateway/src && bun test config/asset-root.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it into startup config**

In `gateway/src/config/startup-config.ts`, change the import to add `resolveWebDistDir` alongside whatever `asset-root.ts` already exports there (add the import line if the file does not import from it yet):

```ts
import { resolveWebDistDir } from "./asset-root.ts";
```

Then replace line 176:

```ts
    webDistDir: process.env.WEB_DIST_DIR,
```

with:

```ts
    // Derived from the asset root so an installed release and a repo checkout
    // both work with no env var. WEB_DIST_DIR remains an override, handled
    // inside resolveWebDistDir — it was previously the ONLY source, and being
    // set nowhere in the repo is why prod served no UI at all.
    webDistDir: resolveWebDistDir(),
```

- [ ] **Step 6: Verify typecheck and full unit suite**

Run: `source scripts/env.sh && bun run typecheck && cd gateway/src && bun test`
Expected: typecheck clean; unit suite green.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/config/asset-root.ts gateway/src/config/asset-root.test.ts gateway/src/config/startup-config.ts
git commit -m "fix(gateway): serve the web UI — WEB_DIST_DIR was set nowhere"
```

---

### Task 2: Enforce `key.pem` mode 0600

Spec §2.5 / §4.7. The 0600 claim was an assumption; `runOpenssl` never chmods.

**Files:**
- Modify: `shared/tls/src/tls.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: nothing new — `ensureTlsMaterial()` signature is unchanged

- [ ] **Step 1: Read the current generation path**

Run: `source scripts/env.sh && sed -n '60,90p' shared/tls/src/tls.ts`
Note where `runOpenssl` finishes writing `paths.key` and `paths.marker`.

- [ ] **Step 2: Add the chmod**

In `shared/tls/src/tls.ts`, add `chmodSync` to the existing `node:fs` import, then immediately after openssl returns and before `writeFileSync(paths.marker, ...)`, insert:

```ts
  // openssl's umask decides the key's mode otherwise, and a 0644 private key
  // mounted read-only into the inbound proxy is readable by anything else that
  // gets a mount of the same directory. Asserted in docs for a long time and
  // never actually enforced.
  chmodSync(paths.key, 0o600);
```

- [ ] **Step 3: Verify against a real generation**

```bash
source scripts/env.sh
rm -rf /tmp/tls-mode-check && mkdir -p /tmp/tls-mode-check
cd gateway && GATEWAY_CERTS_DIR=/tmp/tls-mode-check bun -e '
  const { ensureTlsMaterial } = await import("@sentient/tls");
  ensureTlsMaterial({ hostnames: ["localhost"], certsDir: "/tmp/tls-mode-check", logTag: "check" });
'
stat -f "%Sp %N" /tmp/tls-mode-check/key.pem
```

Expected: `-rw------- /tmp/tls-mode-check/key.pem`

- [ ] **Step 4: Commit**

```bash
git add shared/tls/src/tls.ts
git commit -m "fix(tls): chmod key.pem 0600 — the mode was assumed, never set"
```

---

### Task 3: `sentient-edge` network and the `infra` service class flag

Spec §2.2 / §2.4. Config surface only — behaviour arrives in Tasks 5, 6, 7.

**Files:**
- Modify: `gateway/src/system-orchestrator/types.ts:40-43`, `:55-59`
- Test: `gateway/src/system-orchestrator/types.test.ts`

**Interfaces:**
- Produces: `MANAGED_NETWORK_TOPOLOGY` gains `"sentient-edge": { internal: false }`; `ManagedServiceConfig` gains `infra: boolean` (default `false`) on both docker and native variants.

- [ ] **Step 1: Write the failing test**

Append to `gateway/src/system-orchestrator/types.test.ts`:

```ts
import { MANAGED_NETWORK_TOPOLOGY, ManagedServiceConfigSchema } from "./types.js";

describe("sentient-edge", () => {
  it("is declared non-internal so docker does not drop the publish", () => {
    expect(MANAGED_NETWORK_TOPOLOGY["sentient-edge"]).toEqual({ internal: false });
  });
});

describe("infra flag", () => {
  it("defaults to false so every existing service entry is unchanged", () => {
    const parsed = ManagedServiceConfigSchema.parse({
      template: "x.yaml",
      allowed_images: ["a:b"],
      networks: ["sentient-internal"],
      healthcheck: { noop: true },
    });
    expect(parsed.infra).toBe(false);
  });

  it("parses infra: true on a docker service", () => {
    const parsed = ManagedServiceConfigSchema.parse({
      template: "x.yaml",
      allowed_images: ["a:b"],
      networks: ["sentient-edge"],
      healthcheck: { noop: true },
      infra: true,
    });
    expect(parsed.infra).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/types.test.ts`
Expected: FAIL — `sentient-edge` is undefined and `parsed.infra` is undefined.

- [ ] **Step 3: Add the network**

In `gateway/src/system-orchestrator/types.ts`, replace the `MANAGED_NETWORK_TOPOLOGY` body:

```ts
export const MANAGED_NETWORK_TOPOLOGY: ManagedNetworks = Object.freeze({
  "sentient-internal": { internal: true },
  "sentient-external": { internal: false },
  // The PUBLIC edge, and deliberately its own segment. inbound-proxy's only
  // upstream is host loopback — it needs zero container reachability. Putting it
  // on sentient-external instead would share an L2 segment with ha-mcp, ma-mcp,
  // searxng-mcp and egress-proxy, handing the one internet-facing container
  // lateral reach it has no use for. Non-internal because docker silently drops
  // port publishing when every attached network is internal.
  "sentient-edge": { internal: false },
});
```

- [ ] **Step 4: Add the `infra` flag**

In the same file, replace `CommonServiceFields`:

```ts
const CommonServiceFields = {
  healthcheck: HealthCheckSchema,
  depends_on: z.array(ServiceNameSchema).optional().default([]),
  optional: z.boolean().optional().default(false),
  /** INFRASTRUCTURE class. A capability addon can wait for the wizard, be given
   *  up on, and be recreated freely. The public door cannot: waiting for the
   *  wizard means no route TO the wizard on a fresh host, giving up means the
   *  only entrance stays dead until someone notices, and recreating on every
   *  `bun --watch` save drops 80/443 on every keystroke.
   *
   *  Three behaviours change, all fail-safe in the false direction:
   *    - applied before bootstrap completes  (bootstrap/phase-orchestrator.ts)
   *    - never given up on by the watchdog   (system-orchestrator/health-watch.ts)
   *    - not recreated when unchanged+healthy (system-orchestrator/docker-driver.ts)
   *
   *  Default false: every pre-existing entry keeps today's behaviour exactly. */
  infra: z.boolean().optional().default(false),
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/types.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify nothing else regressed**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/`
Expected: all orchestrator tests green.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/system-orchestrator/types.ts gateway/src/system-orchestrator/types.test.ts
git commit -m "feat(orchestrator): add sentient-edge network and the infra service class"
```

---

### Task 4: The public-port exception

Spec §2.3 / §4.3. **This is a security boundary — the loopback rule stays the default and this is the one narrow, fail-closed hole.** All three enforcement sites must move together.

**Files:**
- Modify: `gateway/src/system-orchestrator/types.ts`
- Modify: `gateway/src/system-orchestrator/template-loader.ts`
- Modify: `gateway/src/system-orchestrator/service-registry.ts:127-132`
- Modify: `gateway/src/system-orchestrator/docker-driver.ts:278-295`
- Test: `gateway/src/system-orchestrator/template-loader.test.ts`, `docker-driver.test.ts`

**Interfaces:**
- Consumes: `infra` from Task 3 (independent flag — `public_ports` is separate)
- Produces:
  - `PUBLIC_PORT_RE: RegExp` and `PUBLIC_PORT_REASON: string` in `types.ts`
  - `isAllowedPortMapping(entry: string, allowPublic: boolean): boolean` in `types.ts`
  - `DockerServiceConfig` gains `public_ports: boolean` (default `false`)
  - `LoadTemplateInput` gains `allowPublicPorts?: boolean`

- [ ] **Step 1: Write the failing tests**

Append to `gateway/src/system-orchestrator/template-loader.test.ts`:

```ts
import { loadServiceTemplate } from "./template-loader.js";

const noSecrets = { resolve: () => null };

function body(ports: string[]): string {
  return [
    "image: nginx:1.30-alpine",
    "container_name: c",
    "networks: [sentient-edge]",
    `ports: [${ports.map((p) => `"${p}"`).join(", ")}]`,
  ].join("\n");
}

describe("public port exception", () => {
  it("rejects a 0.0.0.0 publish when public_ports is not set", async () => {
    const r = await loadServiceTemplate({
      yamlBody: body(["0.0.0.0:443:8443"]),
      secretBindings: {},
      secrets: noSecrets,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("policy-violation");
  });

  it("accepts 0.0.0.0:443 and 0.0.0.0:80 when public_ports is set", async () => {
    const r = await loadServiceTemplate({
      yamlBody: body(["0.0.0.0:443:8443", "0.0.0.0:80:8080"]),
      secretBindings: {},
      secrets: noSecrets,
      allowPublicPorts: true,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a public port other than 80 or 443 even when public_ports is set", async () => {
    const r = await loadServiceTemplate({
      yamlBody: body(["0.0.0.0:8888:8888"]),
      secretBindings: {},
      secrets: noSecrets,
      allowPublicPorts: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("policy-violation");
  });

  it("still accepts loopback publishes when public_ports is set", async () => {
    const r = await loadServiceTemplate({
      yamlBody: body(["127.0.0.1:8088:8088"]),
      secretBindings: {},
      secrets: noSecrets,
      allowPublicPorts: true,
    });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/template-loader.test.ts`
Expected: FAIL — the two "accepts" cases fail because `allowPublicPorts` is ignored.

- [ ] **Step 3: Add the predicate to `types.ts`**

Replace the `LOOPBACK_PORT_RE` block and `LoopbackPortSchema` in `gateway/src/system-orchestrator/types.ts`:

```ts
export const LOOPBACK_PORT_RE = /^127\.0\.0\.1:\d{1,5}:\d{1,5}$/;
export const LOOPBACK_PORT_REASON = "ports must bind 127.0.0.1 explicitly (127.0.0.1:host:container)";

/** The ONE exception to the loopback rule, and it is deliberately not general.
 *  `0.0.0.0:<80|443>:<container>` only, and only for a service whose POLICY
 *  entry sets `public_ports: true` — the template alone can never grant it.
 *
 *  Two locks, because either alone is one edit away from opening every addon to
 *  the LAN: the host port is pinned to the two ports a web entrance actually
 *  needs, and the grant lives in operator config rather than in the template a
 *  service ships with. */
export const PUBLIC_PORT_RE = /^0\.0\.0\.0:(80|443):\d{1,5}$/;
export const PUBLIC_PORT_REASON =
  "a public publish must be 0.0.0.0:80 or 0.0.0.0:443 AND the service's config must set public_ports: true";

/** Single source of truth for "may this template publish this mapping". Read by
 *  all three enforcement layers (schema, template-loader, docker-driver) so they
 *  cannot drift — the previous duplication of LOOPBACK_PORT_RE across the three
 *  is the pattern this replaces. */
export function isAllowedPortMapping(entry: string, allowPublic: boolean): boolean {
  if (LOOPBACK_PORT_RE.test(entry)) return true;
  return allowPublic && PUBLIC_PORT_RE.test(entry);
}

/** Schema-level layer. It cannot see policy, so it admits the SHAPE of both and
 *  leaves the grant check to the loader and driver, which do see policy. */
const PortMappingSchema = z
  .string()
  .refine((v) => LOOPBACK_PORT_RE.test(v) || PUBLIC_PORT_RE.test(v), `${LOOPBACK_PORT_REASON}; ${PUBLIC_PORT_REASON}`);
```

Then change `ServiceTemplateSchema`'s `ports` field from `z.array(LoopbackPortSchema)` to `z.array(PortMappingSchema)`.

Add `public_ports` to `DockerServiceConfigSchema` (docker only — a native service publishes nothing):

```ts
export const DockerServiceConfigSchema = z.object({
  launch: z.literal("docker"),
  template: z.string().min(1),
  allowed_images: z.array(z.string().min(1)).nonempty(),
  networks: z.array(z.string().min(1)).nonempty(),
  secrets: z.record(z.string(), z.string()).optional().default({}),
  /** Grants this service the §2.3 public-port exception. Default false, so the
   *  loopback rule holds for every entry that does not name it explicitly.
   *  Separate from `infra`: one is a lifecycle class, this is an exposure grant,
   *  and coupling them would mean any future infra service silently gained the
   *  right to bind 0.0.0.0. */
  public_ports: z.boolean().optional().default(false),
  ...CommonServiceFields,
});
```

- [ ] **Step 4: Thread it through the loader**

In `gateway/src/system-orchestrator/template-loader.ts`:

Change the import line to pull the predicate:

```ts
import {
  LOOPBACK_PORT_REASON,
  PUBLIC_PORT_REASON,
  isAllowedPortMapping,
  type ServiceTemplate,
  ServiceTemplateSchema,
} from "./types.js";
```

Add the field to `LoadTemplateInput`:

```ts
  /** Grants the §2.3 public-port exception for THIS service. Comes from the
   *  service's policy entry (config.yaml#managed_services.<svc>.public_ports),
   *  never from the template body — a template cannot grant itself LAN exposure. */
  allowPublicPorts?: boolean;
```

Change the call site:

```ts
  const portPolicy = enforcePortPolicy(parsed, input.allowPublicPorts === true);
```

And replace `enforceLoopbackPorts` with:

```ts
/** Every published port must bind loopback, unless this service's policy grants
 *  the narrow public exception (types.ts#isAllowedPortMapping). A bare
 *  `"8086:8086"` publishes on 0.0.0.0 (docker's default), which would put the
 *  addon on the LAN. */
function enforcePortPolicy(parsed: unknown, allowPublic: boolean): Result<undefined, TemplateError> {
  if (!parsed || typeof parsed !== "object") return { ok: true, value: undefined };
  const ports = (parsed as Record<string, unknown>).ports;
  if (ports === undefined) return { ok: true, value: undefined };
  const rule = allowPublic ? `${LOOPBACK_PORT_REASON}; ${PUBLIC_PORT_REASON}` : LOOPBACK_PORT_REASON;
  if (!Array.isArray(ports)) {
    return { ok: false, error: { kind: "policy-violation", reason: `ports must be a list; ${rule}` } };
  }
  for (const entry of ports) {
    if (typeof entry === "string" && isAllowedPortMapping(entry, allowPublic)) continue;
    const preview = String(entry).slice(0, PORT_PREVIEW_MAX);
    log.warn("template.port-policy-violation", { port: preview, allowPublic, reason: rule });
    return { ok: false, error: { kind: "policy-violation", reason: `${rule}; got ${preview}` } };
  }
  return { ok: true, value: undefined };
}
```

- [ ] **Step 5: Pass policy from the registry**

In `gateway/src/system-orchestrator/service-registry.ts`, change the `loadServiceTemplate` call (currently at line 127):

```ts
  const tplResult = await loadServiceTemplate({
    yamlBody,
    secretBindings: cfg.secrets,
    secrets: input.secrets,
    // The grant lives in POLICY and is read here, where policy and template meet.
    allowPublicPorts: cfg.public_ports,
    ...(input.hostEnv ? { hostEnv: input.hostEnv } : {}),
  });
```

- [ ] **Step 6: Run the loader tests**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/template-loader.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the driver test**

Append to `gateway/src/system-orchestrator/docker-driver.test.ts`, following the existing fake-docker pattern in that file:

```ts
describe("public port publishing", () => {
  it("writes HostIp 0.0.0.0 for a granted public port", async () => {
    const { docker, created } = makeFakeDocker();
    const driver = createDockerDriver({ docker, networks: MANAGED_NETWORK_TOPOLOGY });
    const ms = dockerService({
      config: { public_ports: true, networks: ["sentient-edge"] },
      template: { networks: ["sentient-edge"], ports: ["0.0.0.0:443:8443"] },
    });

    const r = await driver.recreate(ms);

    expect(r.ok).toBe(true);
    expect(created[0]?.HostConfig.PortBindings["8443/tcp"]).toEqual([{ HostIp: "0.0.0.0", HostPort: "443" }]);
  });

  it("refuses a public port when the policy does not grant it", async () => {
    const { docker } = makeFakeDocker();
    const driver = createDockerDriver({ docker, networks: MANAGED_NETWORK_TOPOLOGY });
    const ms = dockerService({
      config: { public_ports: false, networks: ["sentient-edge"] },
      template: { networks: ["sentient-edge"], ports: ["0.0.0.0:443:8443"] },
    });

    const r = await driver.recreate(ms);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("policy-violation");
  });
});
```

If `makeFakeDocker` / `dockerService` helpers do not exist under those names, reuse whatever the file already uses and keep the two assertions identical.

- [ ] **Step 8: Run to verify it fails**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/docker-driver.test.ts`
Expected: FAIL — the driver still hardcodes `HostIp: LOOPBACK_HOST_IP`.

- [ ] **Step 9: Implement in the driver**

In `gateway/src/system-orchestrator/docker-driver.ts`, add `PUBLIC_HOST_IP` beside the existing `LOOPBACK_HOST_IP` constant:

```ts
/** Written explicitly for a granted public publish. Only reachable through
 *  isAllowedPortMapping, which pins the host port to 80/443 AND requires the
 *  service's policy to set public_ports. */
const PUBLIC_HOST_IP = "0.0.0.0";
```

Update the import from `./types.js` to bring in `isAllowedPortMapping`, `PUBLIC_PORT_RE`, and `PUBLIC_PORT_REASON`, then replace `buildPortPublishing`:

```ts
function buildPortPublishing(ms: DockerManagedService): Result<PortPublishing, DriverError> {
  const out: PortPublishing = { exposed: {}, bindings: {} };
  const allowPublic = ms.config.public_ports;
  for (const entry of ms.template.ports) {
    // Third and last enforcement layer. Re-tested here rather than trusted from
    // the loader because this is the function that actually writes HostIp, and a
    // wrong HostIp is the whole LAN.
    if (!isAllowedPortMapping(entry, allowPublic)) {
      const rule = allowPublic ? `${LOOPBACK_PORT_REASON}; ${PUBLIC_PORT_REASON}` : LOOPBACK_PORT_REASON;
      const reason = `${rule}; got ${entry}`;
      log.warn("driver.port-policy-violation", { service: ms.name, allowPublic, reason });
      return { ok: false, error: { kind: "policy-violation", reason } };
    }
    const [, hostPort, containerPort] = entry.split(":");
    const key = `${containerPort}/${PORT_PROTO}`;
    const hostIp = PUBLIC_PORT_RE.test(entry) ? PUBLIC_HOST_IP : LOOPBACK_HOST_IP;
    out.exposed[key] = {};
    out.bindings[key] = [{ HostIp: hostIp, HostPort: hostPort ?? "" }];
  }
  if (ms.template.ports.length > 0) {
    log.info("driver.ports-published", { service: ms.name, ports: ms.template.ports, public: allowPublic });
  }
  return { ok: true, value: out };
}
```

- [ ] **Step 10: Run the full orchestrator suite**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/ && cd ../.. && bun run typecheck`
Expected: all green, typecheck clean.

- [ ] **Step 11: Commit**

```bash
git add gateway/src/system-orchestrator/
git commit -m "feat(orchestrator): narrow public-port exception for the edge, fail-closed at three layers"
```

---

### Task 5: Spec hash + skip-recreate for infra services

Spec §2.2 / §1.5. Without this, every `bun --watch` save deletes and recreates the container holding 80/443.

**Files:**
- Create: `gateway/src/system-orchestrator/spec-hash.ts`
- Modify: `gateway/src/system-orchestrator/docker-driver.ts`
- Test: `gateway/src/system-orchestrator/docker-driver.test.ts`

**Interfaces:**
- Consumes: `infra` from Task 3
- Produces: `computeSpecHash(spec: Record<string, unknown>): string` — hex SHA-256, `Labels` excluded.

- [ ] **Step 1: Create the hash module**

Create `gateway/src/system-orchestrator/spec-hash.ts`:

```ts
// Stable fingerprint of a container create-spec, so a reconcile can tell "this
// container is already exactly what I would create" from "this one is stale".
//
// WHY IT HASHES THE CREATE-SPEC AND NOT THE INSPECTED CONTAINER: docker
// normalises what it stores — it fills defaults, reorders, and rewrites some
// fields — so comparing our intent against docker's readback compares two
// different vocabularies and reports drift that is not drift. Hashing what we
// SEND, and stamping that hash on the container as a label, compares intent to
// intent.
import { createHash } from "node:crypto";

/** Excluded from the hash because the hash itself is stored in Labels — feeding
 *  it back in would make the value depend on itself. Every other create-spec
 *  field participates: image, command, env, ports, binds, networks, limits. */
const EXCLUDED_KEYS = new Set(["Labels"]);

/** Deterministic JSON: object keys sorted at every depth, arrays left in order
 *  (array order IS semantic for Cmd, Binds and Env). Without the sort, two
 *  identical specs built from differently-ordered object literals hash
 *  differently and the skip never fires. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => !EXCLUDED_KEYS.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Hex SHA-256 of the create-spec, `Labels` excluded. */
export function computeSpecHash(spec: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(spec)).digest("hex");
}
```

- [ ] **Step 2: Write the failing driver test**

Append to `gateway/src/system-orchestrator/docker-driver.test.ts`:

```ts
describe("infra skip-recreate", () => {
  it("skips recreate when an infra container is running with a matching spec hash", async () => {
    const { docker, created, removed } = makeFakeDocker();
    const driver = createDockerDriver({ docker, networks: MANAGED_NETWORK_TOPOLOGY });
    const ms = dockerService({
      config: { infra: true, public_ports: true, networks: ["sentient-edge"] },
      template: { networks: ["sentient-edge"], ports: ["0.0.0.0:443:8443"] },
    });

    const first = await driver.recreate(ms);
    expect(first.ok).toBe(true);
    const createdOnce = created.length;
    const removedOnce = removed.length;

    const second = await driver.recreate(ms);

    expect(second.ok).toBe(true);
    expect(created.length).toBe(createdOnce); // no second create
    expect(removed.length).toBe(removedOnce); // and nothing torn down
  });

  it("recreates an infra container whose spec changed", async () => {
    const { docker, created } = makeFakeDocker();
    const driver = createDockerDriver({ docker, networks: MANAGED_NETWORK_TOPOLOGY });
    const base = dockerService({
      config: { infra: true, public_ports: true, networks: ["sentient-edge"] },
      template: { networks: ["sentient-edge"], ports: ["0.0.0.0:443:8443"] },
    });
    await driver.recreate(base);
    const createdOnce = created.length;

    const changed = dockerService({
      config: { infra: true, public_ports: true, networks: ["sentient-edge"] },
      template: { networks: ["sentient-edge"], ports: ["0.0.0.0:443:8443"], env: { CHANGED: "1" } },
    });
    const r = await driver.recreate(changed);

    expect(r.ok).toBe(true);
    expect(created.length).toBe(createdOnce + 1);
  });

  it("always recreates a NON-infra container even when unchanged", async () => {
    const { docker, created } = makeFakeDocker();
    const driver = createDockerDriver({ docker, networks: MANAGED_NETWORK_TOPOLOGY });
    const ms = dockerService({
      config: { infra: false, networks: ["sentient-internal"] },
      template: { networks: ["sentient-internal"], ports: [] },
    });

    await driver.recreate(ms);
    const createdOnce = created.length;
    await driver.recreate(ms);

    expect(created.length).toBe(createdOnce + 1);
  });
});
```

The fake docker needs `getContainer(name).inspect()` to return the last created container's `Labels` plus `State: { Running: true }`, and to reject with `{ statusCode: 404 }` before anything is created. Extend the existing fake in that file accordingly, and record removals in a `removed` array.

- [ ] **Step 3: Run to verify it fails**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/docker-driver.test.ts`
Expected: FAIL — the first test sees a second create because `recreate` is unconditional.

- [ ] **Step 4: Stamp the hash label**

In `gateway/src/system-orchestrator/docker-driver.ts`, add the label constant beside the existing two:

```ts
/** Fingerprint of the create-spec that produced this container. Read on reconcile
 *  so an infra service that has not changed is left alone. */
const LABEL_SPEC_HASH = "sentient.spec-hash";
```

Import the hasher:

```ts
import { computeSpecHash } from "./spec-hash.js";
```

Change `buildCreateSpec` so the hash is computed from the spec and then stamped into it:

```ts
function buildCreateSpec(ms: DockerManagedService, published: PortPublishing): Record<string, unknown> {
  const env = Object.entries(ms.template.env).map(([k, v]) => `${k}=${v}`);
  const primaryNet = ms.template.networks[0] ?? "";
  const spec: Record<string, unknown> = {
    name: ms.template.container_name,
    Image: ms.template.image,
    Cmd: ms.template.command,
    Env: env,
    ExposedPorts: published.exposed,
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      // NetworkMode pins the container to its primary network. NetworkingConfig
      // attaches that same network at create time; additional networks are
      // attached after create via docker.network.connect (see recreate above).
      NetworkMode: primaryNet,
      Binds: ms.template.volumes,
      ExtraHosts: ms.template.extra_hosts,
      Memory: ms.template.mem_limit_bytes ?? 0,
      NanoCpus: ms.template.cpus ? Math.floor(ms.template.cpus * 1_000_000_000) : 0,
      GroupAdd: ms.template.group_add,
      // Loopback-only unless the service's policy grants the §2.3 public
      // exception, built by buildPortPublishing. Empty when the template
      // declares no ports — defence in depth against accidental exposure.
      PortBindings: published.bindings,
    },
    // NetworkingConfig is intentionally omitted — Docker only honours the
    // first entry at create time, so secondary networks would be silently
    // dropped here. They are attached after create via network.connect.
  };
  // Stamped AFTER the hash is taken, and excluded from it by spec-hash.ts —
  // a label that fed into its own value could never be stable.
  spec.Labels = {
    [LABEL_MANAGED]: "true",
    [LABEL_SERVICE]: ms.name,
    [LABEL_SPEC_HASH]: computeSpecHash(spec),
  };
  return spec;
}
```

- [ ] **Step 5: Add the skip check**

In the same file, add:

```ts
/** True when this exact spec is already running under this container name.
 *
 *  Deliberately requires BOTH: a matching hash on a stopped container is not a
 *  reason to leave it alone, and a running container with a stale hash is not
 *  the thing we were asked to create. Any inspect failure — 404, unreadable
 *  label, unreachable daemon — answers false, so the fallback is always the
 *  existing recreate path. */
async function isUnchangedAndRunning(
  docker: DockerodeLike,
  ms: DockerManagedService,
  published: PortPublishing,
): Promise<boolean> {
  try {
    const info = (await docker.getContainer(ms.template.container_name).inspect()) as {
      State?: { Running?: boolean };
      Config?: { Labels?: Record<string, string> };
    };
    if (info.State?.Running !== true) return false;
    const want = computeSpecHash(buildCreateSpec(ms, published));
    return info.Config?.Labels?.[LABEL_SPEC_HASH] === want;
  } catch {
    return false;
  }
}
```

Then in `recreate`, immediately after the `buildPortPublishing` block (after `if (!published.ok) return published;`), insert:

```ts
  // INFRA ONLY. A capability addon is cheap to recreate and recreating it is the
  // simplest correct thing. The public door is not: under `bun --watch` the
  // gateway restarts on every source save, and an unconditional recreate would
  // drop 80/443 on every keystroke. Skipping the recreate does NOT skip the
  // health probe or verifyIdentity — the orchestrator still runs both after this
  // returns, so "something else grabbed the port" is still caught.
  if (ms.config.infra && (await isUnchangedAndRunning(docker, ms, published.value))) {
    log.info("driver.recreate-skipped", { service: ms.name, reason: "infra-unchanged-and-running" });
    return { ok: true, value: undefined };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/`
Expected: PASS, including the three new cases.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/system-orchestrator/spec-hash.ts gateway/src/system-orchestrator/docker-driver.ts gateway/src/system-orchestrator/docker-driver.test.ts
git commit -m "feat(orchestrator): skip recreate for an unchanged, running infra service"
```

---

### Task 6: The watchdog never gives up on an infra service

Spec §2.2. `docs/native-todo.md` documents Docker Desktop starting after the LaunchDaemon by a margin that can exceed the backoff budget — under today's rule the only public entrance would give up permanently.

**Files:**
- Modify: `gateway/src/system-orchestrator/health-watch.ts`
- Modify: `gateway/src/system-orchestrator/index.ts:223-262`
- Test: `gateway/src/system-orchestrator/health-watch.test.ts`

**Interfaces:**
- Consumes: `infra` from Task 3
- Produces: `HealthWatchDeps` gains `neverGiveUp?: (name: ServiceName) => boolean`

- [ ] **Step 1: Write the failing test**

Append to `gateway/src/system-orchestrator/health-watch.test.ts`, matching the fake-timer style already used there:

```ts
it("keeps re-applying a neverGiveUp service past maxAttempts", async () => {
  const reapplied: string[] = [];
  const watch = createHealthWatch({
    intervalMs: 10,
    listServices: () => ["inbound-proxy"],
    probe: async () => false,
    reapply: async (n) => {
      reapplied.push(n);
    },
    maxAttempts: 2,
    backoffFactor: 1,
    neverGiveUp: (n) => n === "inbound-proxy",
  });

  watch.start();
  // Six intervals is three times the give-up budget.
  await advanceTicks(6, 10);
  watch.stop();

  expect(reapplied.length).toBeGreaterThan(2);
});

it("still gives up on a service that is not neverGiveUp", async () => {
  const reapplied: string[] = [];
  const watch = createHealthWatch({
    intervalMs: 10,
    listServices: () => ["ha-mcp"],
    probe: async () => false,
    reapply: async (n) => {
      reapplied.push(n);
    },
    maxAttempts: 2,
    backoffFactor: 1,
    neverGiveUp: () => false,
  });

  watch.start();
  await advanceTicks(6, 10);
  watch.stop();

  expect(reapplied.length).toBe(2);
});
```

Reuse the file's existing tick-advancing helper. If none exists, drive it with real `setTimeout` waits of `intervalMs * n + 5`.

- [ ] **Step 2: Run to verify it fails**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/health-watch.test.ts`
Expected: FAIL — the first case caps at 2 because `neverGiveUp` is ignored.

- [ ] **Step 3: Implement in `health-watch.ts`**

Add to `HealthWatchDeps`:

```ts
  /** Services that must never be abandoned. Giving up is right for a capability
   *  addon — a broken one recreated every tick is sustained load for no gain —
   *  but the public entrance has no operator watching it and no other path back:
   *  once given up on it stays dead until someone restarts the gateway by hand.
   *  Docker Desktop starting AFTER the LaunchDaemon (docs/native-todo.md) puts
   *  the proxy inside that window on a routine reboot. */
  neverGiveUp?: (name: ServiceName) => boolean;
```

Read it in the factory:

```ts
  const neverGiveUp = deps.neverGiveUp ?? (() => false);
```

Change `handleUnhealthy`'s give-up branch:

```ts
    if (state.attempts >= maxAttempts && !neverGiveUp(name)) {
      log.error("reapply.gave-up", {
        service: name,
        reason: "max-attempts-exhausted",
        attempts: state.attempts,
        maxAttempts,
      });
      states.set(name, { ...state, gaveUp: true });
      return;
    }
```

And keep the backoff from growing without bound for a never-give-up service — in `reapplyOnce`, cap the exponent:

```ts
  const attempt = state.attempts + 1;
  // Cap the exponent at maxAttempts so a never-give-up service settles into a
  // steady retry cadence instead of backing off toward never. Without the cap,
  // attempt 40 waits longer than the machine's uptime.
  const exponent = Math.min(attempt - 1, maxAttempts);
  const backoffMs = deps.intervalMs * backoffFactor ** exponent;
```

- [ ] **Step 4: Run to verify it passes**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/health-watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it in `index.ts`**

In `gateway/src/system-orchestrator/index.ts`, add to the `createHealthWatch({...})` call (after `isApplyInFlight`):

```ts
    // Infra services are the ones with no second path back — see types.ts#infra.
    neverGiveUp: (name) => currentRegistry.get(name)?.config.infra === true,
```

- [ ] **Step 6: Verify and commit**

Run: `source scripts/env.sh && cd gateway/src && bun test system-orchestrator/ && cd ../.. && bun run typecheck`

```bash
git add gateway/src/system-orchestrator/health-watch.ts gateway/src/system-orchestrator/health-watch.test.ts gateway/src/system-orchestrator/index.ts
git commit -m "feat(orchestrator): watchdog never abandons an infra service"
```

---

### Task 7: Apply infra services before bootstrap completes

Spec §1.4 / §2.2. **This is the fresh-install deadlock.** With the gateway on loopback and no proxy running, a brand-new host has no route to the wizard from any device.

**Files:**
- Modify: `gateway/src/system-orchestrator/index.ts` (add `reconcileInfraOnly`)
- Modify: `gateway/src/bootstrap/phase-orchestrator.ts:330-343`

**Interfaces:**
- Consumes: `infra` (Task 3), `applySubset` (existing)
- Produces: `SystemOrchestratorService.reconcileInfraOnly(): Promise<OrchestratorStatus>`

- [ ] **Step 1: Add `reconcileInfraOnly` to the service interface**

In `gateway/src/system-orchestrator/index.ts`, add to the exported interface beside `reconcile()`:

```ts
  /** Boot path for a host that has NOT finished the wizard. Applies only the
   *  infra class and arms the watchdog. The wizard still owns the first apply of
   *  every capability addon, so its bringup screen is unchanged. */
  reconcileInfraOnly(): Promise<OrchestratorStatus>;
```

Add the implementation to the returned object, after `reconcile`:

```ts
    reconcileInfraOnly: async () => {
      const infraNames = new Set(
        Array.from(currentRegistry.values())
          .filter((ms) => ms.config.infra)
          .map((ms) => ms.name),
      );
      // Same unconditional-arming contract as reconcile() — see its comment.
      // The watchdog is what recovers the public door when Docker Desktop comes
      // up after the gateway, which is the routine case on a rebooted mini.
      try {
        if (infraNames.size === 0) {
          log.info("boot-reconcile.infra-only.empty", { reason: "no infra services in the registry" });
          return lastStatus;
        }
        log.info("boot-reconcile.infra-only", { services: Array.from(infraNames) });
        await nativeDriver.reapOrphans();
        return await applySubsetSerialized(infraNames);
      } finally {
        healthWatch.start();
      }
    },
```

- [ ] **Step 2: Branch at the bootstrap gate**

In `gateway/src/bootstrap/phase-orchestrator.ts`, replace the boot-reconcile block (lines 324-343):

```ts
  // Boot reconcile — replays applyAll once on startup so gateway restarts
  // (after a crash, image rebuild, etc.) repopulate orchestrator status from
  // the live container set. Fire-and-forget either way.
  //
  // On a FRESH install the wizard still owns the first applyAll of every
  // capability addon — pre-applying them makes the bringup screen flash past.
  // But the INFRA class cannot wait for the wizard: with the gateway bound to
  // loopback, inbound-proxy IS the route to the wizard, so deferring it means
  // the fresh host has no reachable UI on any interface. Hence the split.
  let bootReconcile: Promise<OrchestratorStatus> | null = null;
  if (systemOrchestrator) {
    const installed = await installState.load();
    const orch = systemOrchestrator;
    const run = installed.bootstrap_complete ? () => orch.reconcile() : () => orch.reconcileInfraOnly();
    bootReconcile = run().catch((err: unknown) => {
      log.warn("boot-reconcile.failed", {
        bootstrapComplete: installed.bootstrap_complete,
        reason: err instanceof Error ? err.message : String(err),
      });
      return orch.getStatus();
    });
  }

  return { systemOrchestrator, bootReconcile };
```

- [ ] **Step 3: Verify typecheck and suite**

Run: `source scripts/env.sh && bun run typecheck && cd gateway/src && bun test`
Expected: typecheck clean, suite green.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/system-orchestrator/index.ts gateway/src/bootstrap/phase-orchestrator.ts
git commit -m "fix(bootstrap): apply infra services before the wizard, or a fresh host has no door"
```

---

### Task 8: The `inbound-proxy` image, config, and template

Spec §2.3 / §2.5 / §4.2. The actual proxy.

**Files:**
- Create: `gateway/addons/inbound-proxy/Dockerfile`
- Create: `gateway/addons/inbound-proxy/nginx.conf`
- Create: `gateway/templates/services/inbound-proxy.yaml`
- Modify: `gateway/config.yaml`, `shared/config/src/schema.ts`
- Modify: `gateway/src/bootstrap/phase-orchestrator.ts:261-277`
- Modify: `deploy/mac-prod/docker-compose.yml`

**Interfaces:**
- Consumes: `sentient-edge` (Task 3), `public_ports` + `infra` (Tasks 3-4), skip-recreate (Task 5)
- Produces: container `sentient-inbound-proxy` on host 80/443; `hostEnv.INBOUND_CERT_DIR`

- [ ] **Step 1: Write the nginx config**

Create `gateway/addons/inbound-proxy/nginx.conf`:

```nginx
# inbound-proxy: the PUBLIC host/LAN boundary — the one outward-facing door for
# the whole stack. Not to be confused with gateway/mcp/ingress-proxy/, which
# guards the INTERNAL addon-network boundary. Two proxies, two boundaries; this
# comment is the disambiguation the design asks each of them to carry.
#
# DO NOT copy ingress-proxy's config for the websocket route. That one clears
# `Connection` and never sets `Upgrade`, because it carries MCP Streamable-HTTP
# and SSE, which are not upgrades. Doing the same here breaks /api/v1/ws.
#
# Listens on UNPRIVILEGED ports inside the container; docker maps host 80/443
# onto them, so nothing in this image needs to run privileged.
#
# Included into the stock image's http{} block via /etc/nginx/conf.d/.

server_tokens off;

proxy_http_version 1.1;
# Streaming: the gateway sends token-by-token SSE and long-lived websockets.
proxy_buffering off;
# Must outlast an idle server->client stream, which carries no bytes while the
# session is quiet. nginx's 60s default would cut those mid-conversation.
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;

# Upstream identity. The gateway terminates TLS with its own self-signed cert;
# verifying it — rather than `proxy_ssl_verify off` — is what keeps this hop
# authenticated instead of merely encrypted. `localhost` is the name to present
# because shared/tls/src/tls.ts always puts localhost and 127.0.0.1 in the SAN,
# whatever else the operator adds.
proxy_ssl_verify on;
proxy_ssl_verify_depth 2;
proxy_ssl_trusted_certificate /etc/sentient/upstream/cert.pem;
proxy_ssl_name localhost;
proxy_ssl_server_name on;

# Forwarding headers are OVERWRITTEN, never appended. An appended list lets a
# client pick its own apparent source address by sending the header itself.
proxy_set_header X-Real-IP        $remote_addr;
proxy_set_header X-Forwarded-For  $remote_addr;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header Host             $host;

# 172.17.0.1 is docker's host-gateway on Docker Desktop; extra_hosts in the
# template maps host.docker.internal to it. Resolved at request time so a
# gateway restart does not strand a cached address.
resolver 127.0.0.11 valid=10s ipv6=off;

# ---------------------------------------------------------------------------
# :8080 — mapped from host 80. Redirect only, never a proxy.
# ---------------------------------------------------------------------------
server {
  listen 8080 default_server;
  # 301, not 308: this is a GET-only entrance and 301 is what every client,
  # bookmark and QR reader already understands.
  return 301 https://$host$request_uri;
}

# ---------------------------------------------------------------------------
# :8443 — mapped from host 443. The real door.
# ---------------------------------------------------------------------------
server {
  listen 8443 ssl default_server;
  http2 on;

  ssl_certificate     /etc/sentient/outward/cert.pem;
  ssl_certificate_key /etc/sentient/outward/key.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:4m;
  ssl_session_timeout 1h;

  # Audio uploads and voice-pack reference clips go through here.
  client_max_body_size 64m;

  # WebSocket. The two headers below are the whole reason this block exists
  # separately from `location /`.
  location /api/v1/ws {
    proxy_pass https://sentient_gateway;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
  }

  location / {
    proxy_pass https://sentient_gateway;
  }
}

upstream sentient_gateway {
  # Host loopback. Reachable from inside the container because Docker Desktop's
  # network stack proxies to it from the host-side address (192.168.65.254).
  # THIS IS DOCKER-DESKTOP-SPECIFIC and would NOT work on native Linux, where a
  # loopback-bound service refuses the bridge interface. Measured 2026-08-04;
  # see the design doc §2.7 before moving this stack to a Linux host.
  server host.docker.internal:8888;
  keepalive 16;
}
```

- [ ] **Step 2: Write the Dockerfile**

Create `gateway/addons/inbound-proxy/Dockerfile`:

```dockerfile
# The PUBLIC entrance. Stock nginx, one config, no code of ours — the same
# encapsulation the internal ingress-proxy uses.
FROM nginx:1.30-alpine

COPY nginx.conf /etc/nginx/conf.d/inbound-proxy.conf

# The stock image ships a default server on :80 that would shadow ours.
RUN rm -f /etc/nginx/conf.d/default.conf

# Fail the BUILD on a malformed config rather than at 3am on a restart loop.
# `-t` needs the cert paths to exist; they are mounted at runtime, so point the
# test at throwaway material and delete it in the same layer.
RUN apk add --no-cache openssl \
  && mkdir -p /etc/sentient/outward /etc/sentient/upstream \
  && openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
       -subj "/CN=buildcheck" \
       -keyout /etc/sentient/outward/key.pem \
       -out /etc/sentient/outward/cert.pem 2>/dev/null \
  && cp /etc/sentient/outward/cert.pem /etc/sentient/upstream/cert.pem \
  && nginx -t \
  && rm -f /etc/sentient/outward/key.pem /etc/sentient/outward/cert.pem /etc/sentient/upstream/cert.pem \
  && apk del openssl

EXPOSE 8080 8443
```

- [ ] **Step 3: Build the image and confirm the config parses**

```bash
source scripts/env.sh
docker build -t sentient/inbound-proxy:local gateway/addons/inbound-proxy
```

Expected: build succeeds; the `nginx -t` layer prints `syntax is ok` / `test is successful`. If it fails, the message names the offending directive — fix `nginx.conf` and rebuild before continuing.

- [ ] **Step 4: Write the service template**

Create `gateway/templates/services/inbound-proxy.yaml`:

```yaml
image: sentient/inbound-proxy:local
container_name: sentient-inbound-proxy
# sentient-edge, and ONLY sentient-edge. Its single upstream is host loopback,
# so it needs no reachability to any sibling addon; its own network is what
# denies that reach. Non-internal because docker silently drops port publishing
# when every attached network is internal.
networks: [sentient-edge]
# THE ONE PUBLIC PUBLISH IN THE WHOLE STACK. Permitted only because this
# service's policy entry sets `public_ports: true`, and only for 80/443 —
# see gateway/src/system-orchestrator/types.ts#isAllowedPortMapping.
# Container-side ports are unprivileged; nothing here runs as root.
ports:
  - "0.0.0.0:443:8443"
  - "0.0.0.0:80:8080"
volumes:
  # Outward identity: the real acme.sh cert in prod, the gateway's self-signed
  # material in dev. Resolved by phase-orchestrator.ts, which falls back to the
  # gateway's certs dir when the configured path does not exist — a fresh mini
  # has no acme.sh cert yet and the door still has to open.
  - "${INBOUND_CERT_DIR}:/etc/sentient/outward:ro"
  # Upstream trust anchor: ALWAYS the gateway's own self-signed cert, in both
  # environments. This is what makes the loopback hop verified rather than
  # merely encrypted.
  - "${GATEWAY_CERTS_DIR}:/etc/sentient/upstream:ro"
extra_hosts:
  - "host.docker.internal:host-gateway"
mem_limit_bytes: 134217728    # 128 MiB — nginx, two server blocks, TLS termination
cpus: 0.5
```

- [ ] **Step 5: Add the config schema**

In `shared/config/src/schema.ts`, add beside the TLS block:

```ts
// ---------------------------------------------------------------------------
// inbound-proxy — the public host/LAN entrance
// ---------------------------------------------------------------------------

export const inboundProxyConfigSchema = z.object({
  // Directory holding the cert.pem + key.pem the proxy presents on 443. Null
  // (the default) means "use the gateway's own self-signed material". Prod
  // points this at the externally-managed acme.sh cert. A configured path that
  // does not exist falls back to the self-signed material rather than failing
  // to start — a fresh host has no real cert yet and still needs a door.
  cert_dir: z.string().nullable().default(null),
});
export type InboundProxyConfig = z.output<typeof inboundProxyConfigSchema>;

// ---------------------------------------------------------------------------
// stack — the dev launcher (scripts/stack.sh)
// ---------------------------------------------------------------------------

export const stackConfigSchema = z.object({
  // How long `bun run dev` waits for BOTH the gateway's loopback health and the
  // proxied https://localhost/ before declaring the launch failed. Range
  // 5000-300000. Must outlast a cold image pull plus nginx start.
  readiness_timeout_ms: z.number().int().min(5000).max(300000).default(60000),
  // How often each readiness probe retries within that budget. Range 100-5000.
  readiness_poll_ms: z.number().int().min(100).max(5000).default(500),
  // Seconds to wait for the docker daemon before refusing to launch. Range
  // 0-120. Docker Desktop takes a while from cold on a rebooted machine.
  docker_wait_s: z.number().int().min(0).max(120).default(30),
});
export type StackConfig = z.output<typeof stackConfigSchema>;
```

Register both on the top-level config object in the same file (follow how `tls` is registered), defaulting each to `{}` so an operator config with neither block still parses.

- [ ] **Step 6: Add the config entries**

In `gateway/config.yaml`, add after the `tls:` block:

```yaml
# ---------------------------------------------------------------------------
# inbound-proxy — the ONE outward-facing door (design 2026-08-04 §2)
# ---------------------------------------------------------------------------
inbound_proxy:
  # Directory holding the cert.pem + key.pem presented on 443. null = use the
  # gateway's own self-signed material (~/.sentient/gateway/certs), which is the
  # dev default and the fresh-host fallback. On the mini, point this at the
  # acme.sh-managed real cert:
  #   cert_dir: /Users/OPERATOR/.data/certs/sentient.dev32.io
  cert_dir: null

# ---------------------------------------------------------------------------
# stack — dev launcher budgets (scripts/stack.sh)
# ---------------------------------------------------------------------------
stack:
  readiness_timeout_ms: 60000   # total wait for gateway health AND https://localhost/. Range 5000-300000.
  readiness_poll_ms: 500        # retry interval within that budget. Range 100-5000.
  docker_wait_s: 30             # seconds to wait for the docker daemon before refusing. Range 0-120.
```

And add to `managed_services`, after the `ingress-proxy` entry:

```yaml
  inbound-proxy:
    template: inbound-proxy.yaml
    allowed_images: ["sentient/inbound-proxy:local"]
    networks: ["sentient-edge"]
    # INFRASTRUCTURE class — see gateway/src/system-orchestrator/types.ts#infra.
    # Applied before the wizard (it IS the route to the wizard), never given up
    # on by the watchdog, and not recreated while unchanged and healthy.
    infra: true
    # Grants the ONE public-port exception in the stack. Admits 0.0.0.0:80 and
    # 0.0.0.0:443 only, enforced at three layers.
    public_ports: true
    # Probes the door the LAN actually uses. Self-signed in dev, so the probe is
    # TCP rather than HTTP — an HTTP probe would need a trust anchor the
    # orchestrator has no reason to carry.
    healthcheck:
      tcp: "127.0.0.1:443"
      timeout_ms: 30000
    # Deliberately EMPTY. nginx resolves its upstream at request time, so it does
    # not need the gateway to be up first — and it must not, since the gateway is
    # what starts it.
    depends_on: []
    optional: false
```

- [ ] **Step 7: Resolve `INBOUND_CERT_DIR` at boot**

In `gateway/src/bootstrap/phase-orchestrator.ts`, add above the `hostEnv` literal:

```ts
  // Outward-identity cert for inbound-proxy. Configured path wins when it really
  // exists; otherwise the gateway's own self-signed material. The fallback is
  // load-bearing, not defensive: a fresh mini has no acme.sh cert yet, and an
  // infra-class service that cannot start leaves the host with no door at all.
  const configuredCertDir = cfg.inboundProxy.cert_dir;
  const gatewayCertsDir = cfg.tls.certsDir;
  const inboundCertDir =
    configuredCertDir !== null && existsSync(configuredCertDir) ? configuredCertDir : gatewayCertsDir;
  if (configuredCertDir !== null && inboundCertDir !== configuredCertDir) {
    log.warn("inbound-proxy.cert-fallback", {
      configured: configuredCertDir,
      using: inboundCertDir,
      reason: "configured cert_dir does not exist — serving the gateway's self-signed material instead",
    });
  }
  log.info("inbound-proxy.cert-dir", { dir: inboundCertDir, configured: configuredCertDir });
```

Add `existsSync` to the `node:fs` import, then add both entries to the `hostEnv` object:

```ts
    INBOUND_CERT_DIR: inboundCertDir,
    GATEWAY_CERTS_DIR: gatewayCertsDir,
```

- [ ] **Step 8: Add the compose build entry**

Append to `deploy/mac-prod/docker-compose.yml`:

```yaml
  # Not an MCP either: the PUBLIC entrance (host 80/443). The gateway's
  # orchestrator owns its lifecycle like every other addon; compose only bakes
  # the image. Distinct from ingress-proxy above, which guards the internal
  # addon-network boundary rather than the host one.
  inbound-proxy:
    build:
      context: ../../gateway/addons/inbound-proxy
    image: sentient/inbound-proxy:local
    pull_policy: never
    profiles: ["build-only"]
```

- [ ] **Step 9: Verify the whole thing comes up**

```bash
source scripts/env.sh
docker compose -f deploy/mac-prod/docker-compose.yml --profile build-only build inbound-proxy
cd gateway && bun --watch src/main.ts
```

In a second terminal:

```bash
docker ps --filter name=sentient-inbound-proxy --format '{{.Names}} {{.Status}} {{.Ports}}'
curl -sk https://localhost/api/v1/health
curl -sk -o /dev/null -w '%{http_code} -> %{redirect_url}\n' http://localhost/
```

Expected: container `Up`, ports show `0.0.0.0:80->8080/tcp, 0.0.0.0:443->8443/tcp`; the health call returns the gateway's JSON; the HTTP call prints `301 -> https://localhost/`.

If the health call fails with an SSL error from nginx's side, check `docker logs sentient-inbound-proxy` — a `proxy_ssl` verification failure names the mismatched host, and the fix is the SAN, not `proxy_ssl_verify off`.

- [ ] **Step 10: Commit**

```bash
git add gateway/addons/inbound-proxy/ gateway/templates/services/inbound-proxy.yaml \
        gateway/config.yaml shared/config/src/schema.ts \
        gateway/src/bootstrap/phase-orchestrator.ts deploy/mac-prod/docker-compose.yml
git commit -m "feat(deploy): add inbound-proxy — one public door on 443, 301 from 80"
```

---

### Task 9: Bind the gateway to loopback, with an operator-config migration

Spec §4.5. **Without the migration, every existing prod install silently stays on `0.0.0.0`** — the operator config is seeded once and never overwritten.

**Files:**
- Modify: `gateway/config.yaml:13`
- Modify: `gateway/src/config/operator-config-migrator.ts`
- Test: `gateway/src/config/operator-config-migrator.test.ts`

**Interfaces:**
- Produces: schema version `0.1.4`; `applySchema014Migration(doc: Document): Schema014MigrationResult | null`

- [ ] **Step 1: Write the failing test**

Append to `gateway/src/config/operator-config-migrator.test.ts`, following the existing round-trip style:

```ts
describe("0.1.3 -> 0.1.4: gateway binds loopback", () => {
  it("rewrites host 0.0.0.0 to 127.0.0.1 and bumps the version", () => {
    const doc = parseDocument(['schema_version: "0.1.3"', "port: 8888", "host: 0.0.0.0"].join("\n"));

    const result = applySchema014Migration(doc);

    expect(result).not.toBeNull();
    expect(result?.hostPrev).toBe("0.0.0.0");
    expect(doc.get("host")).toBe("127.0.0.1");
    expect(doc.get("schema_version")).toBe("0.1.4");
  });

  it("leaves a deliberately-customised host alone but still bumps the version", () => {
    const doc = parseDocument(['schema_version: "0.1.3"', "host: 192.168.0.5"].join("\n"));

    const result = applySchema014Migration(doc);

    expect(result?.hostRewritten).toBe(false);
    expect(doc.get("host")).toBe("192.168.0.5");
    expect(doc.get("schema_version")).toBe("0.1.4");
  });

  it("is a no-op on a config that is not at 0.1.3", () => {
    const doc = parseDocument(['schema_version: "0.1.2"', "host: 0.0.0.0"].join("\n"));

    expect(applySchema014Migration(doc)).toBeNull();
    expect(doc.get("host")).toBe("0.0.0.0");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `source scripts/env.sh && cd gateway/src && bun test config/operator-config-migrator.test.ts`
Expected: FAIL — `applySchema014Migration` is not exported.

- [ ] **Step 3: Implement the migration step**

In `gateway/src/config/operator-config-migrator.ts`, after the 0.1.3 block:

```ts
// ---------------------------------------------------------------------------
// 0.1.3 → 0.1.4: the gateway binds loopback, inbound-proxy owns the LAN
// ---------------------------------------------------------------------------

const SCHEMA_014_VERSION = "0.1.4";
const HOST_ALL_INTERFACES = "0.0.0.0";
const HOST_LOOPBACK = "127.0.0.1";

interface Schema014MigrationResult {
  /** What `host` held before, so an operator who chose a value deliberately can
   *  see it in the log rather than discovering it from a refused connection. */
  hostPrev: string | null;
  hostRewritten: boolean;
}

/** Moves the gateway off every interface and behind inbound-proxy.
 *
 *  This step exists because production reads a SEEDED operator config that the
 *  installer never overwrites — changing the checked-in default alone would
 *  leave every existing mini listening on 0.0.0.0 forever, with the new proxy
 *  in front of a gateway that is still directly reachable beside it.
 *
 *  Only the literal 0.0.0.0 is rewritten. A host that says anything else was
 *  set on purpose, and silently overriding a deliberate choice is worse than
 *  leaving a warning in the log. */
function applySchema014Migration(doc: Document): Schema014MigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  const versionNode = root.get("schema_version", true);
  const currentVersion = isScalar(versionNode) ? String(versionNode.value) : null;
  if (currentVersion === SCHEMA_014_VERSION) return null; // already migrated
  if (currentVersion !== SCHEMA_013_VERSION) return null;

  const hostNode = root.get("host", true);
  const hostPrev = isScalar(hostNode) ? String(hostNode.value) : null;
  const hostRewritten = hostPrev === HOST_ALL_INTERFACES;
  if (hostRewritten) root.set("host", HOST_LOOPBACK);

  root.set("schema_version", SCHEMA_014_VERSION);
  return { hostPrev, hostRewritten };
}
```

Export it for the test — add `applySchema014Migration` to the module's exports the same way the earlier steps are exposed (if the earlier steps are private, export all of them consistently or export only this one and note why).

Register it in `applyAllMigrations`:

```ts
  const schema014Result = applySchema014Migration(doc);
```

```ts
  if (schema014Result !== null) {
    log.info("migration:0.1.4", {
      hostPrev: schema014Result.hostPrev,
      hostRewritten: schema014Result.hostRewritten,
      reason: schema014Result.hostRewritten
        ? "the gateway now binds loopback; inbound-proxy owns the LAN-facing 443"
        : "host was customised — left as-is; set it to 127.0.0.1 manually to sit behind inbound-proxy",
    });
  }
```

And add it to the return expression:

```ts
  return (
    webToolsResult !== null ||
    schema011Result !== null ||
    schema012Result !== null ||
    schema013Result !== null ||
    schema014Result !== null
  );
```

- [ ] **Step 4: Run to verify it passes**

Run: `source scripts/env.sh && cd gateway/src && bun test config/operator-config-migrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Change the checked-in default**

In `gateway/config.yaml`, replace lines 12-13:

```yaml
port: 8888
# LOOPBACK ONLY. inbound-proxy (managed_services below) owns the LAN-facing
# 443 and proxies here over the loopback interface; the gateway itself is not
# reachable from another host. Setting this back to 0.0.0.0 puts the API on
# every interface with no policy in front of it.
# Note: https://localhost:8888 still works FROM THIS HOST — that is the
# diagnostic door, not the one browser smoke uses.
host: 127.0.0.1
```

Also bump `schema_version` at line 7 to `"0.1.4"`.

- [ ] **Step 6: Verify the bind really moved**

```bash
source scripts/env.sh
cd gateway && bun --watch src/main.ts
```

Second terminal:

```bash
lsof -nP -iTCP:8888 -sTCP:LISTEN
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8888/api/v1/health
curl -sk -o /dev/null -w '%{http_code}\n' "https://$(ipconfig getifaddr en0):8888/api/v1/health" || echo "refused (expected)"
```

Expected: `lsof` shows `127.0.0.1:8888`, not `*:8888`. Localhost returns 200. The LAN-IP call fails — that is the `gateway-not-lan-reachable` case.

- [ ] **Step 7: Commit**

```bash
git add gateway/config.yaml gateway/src/config/operator-config-migrator.ts gateway/src/config/operator-config-migrator.test.ts
git commit -m "feat(gateway): bind loopback only, with a 0.1.4 operator-config migration"
```

---

### Task 10: Mobile defaults move to 443

Spec §4.6. No migration machinery — an already-paired device is re-pointed from its own settings screen.

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/backend/BackendSetupViewModel.kt:28`
- Modify: `ios/App/SDK/GatewayConfig.swift:16`
- Modify: `ios/App/SDK/BackendSetupViewModel.swift:29`

- [ ] **Step 1: Find every default that still says 8888**

```bash
source scripts/env.sh
grep -rn "8888" --include='*.kt' --include='*.swift' android ios shared/mobile-sdk | grep -v '/test/' | grep -v 'Test.kt'
```

Note each hit. Preview/sample values inside `#Preview` blocks and doc comments count — a stale example is what the next reader copies.

- [ ] **Step 2: Change the Android default**

In `android/src/main/kotlin/io/sentient/android/backend/BackendSetupViewModel.kt`, replace line 28:

```kotlin
// The gateway is no longer LAN-reachable on 8888 — inbound-proxy owns 443 and
// proxies to it over host loopback. A device paired before this change keeps
// its saved port and must be re-pointed from Settings; that is deliberate,
// since guessing at a working port for someone else's install is worse.
private const val DEFAULT_PORT = 443
```

- [ ] **Step 3: Change the iOS defaults**

In `ios/App/SDK/GatewayConfig.swift`, replace line 16:

```swift
        // See BackendSetupViewModel — inbound-proxy owns 443, the gateway is
        // loopback-only behind it.
        return "wss://localhost/api/v1/ws"
```

In `ios/App/SDK/BackendSetupViewModel.swift`, replace line 29's fallback `"8888"` with `"443"`. Update the `#Preview` sample in `BackendSetupView.swift:93` from `port: 8888` to `port: 443` so the mock matches the shipped default.

- [ ] **Step 4: Update the URL-builder tests to the new expectation**

`android/src/test/kotlin/io/sentient/android/backend/BackendConfigTest.kt` pins the URL shape at `:8888`. That test is a real wire-contract test — keep it, but change the port it asserts. Do NOT delete it.

Check whether `toGatewayWsUrl()` should omit the port entirely when it is 443 (the scheme default). Decide by reading the function: if it always interpolates `:$port`, `wss://host:443/...` is valid and unambiguous — leave it interpolating and assert `wss://host:443/api/v1/ws`. Only change the builder if it already special-cases a default.

- [ ] **Step 5: Run the mobile unit tests**

```bash
source scripts/env.sh
cd android && ./gradlew testDebugUnitTest --tests '*BackendConfigTest*'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add android/src ios/App
git commit -m "feat(mobile): default to 443 — the gateway is behind inbound-proxy now"
```

---

### Task 11: `scripts/stack.sh` — the one-command launcher

Spec §3 / §4.8.

**Files:**
- Create: `scripts/stack.sh`
- Modify: `package.json:11`

**Interfaces:**
- Consumes: `stack.readiness_timeout_ms`, `stack.readiness_poll_ms`, `stack.docker_wait_s` from `config.yaml`
- Produces: `scripts/stack.sh {up|down|status}`; npm scripts `dev`, `stack:down`, `stack:status`

- [ ] **Step 1: Write the script**

Create `scripts/stack.sh`:

```bash
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
RUN_DIR="$HOME/.sentient/run"
GATEWAY_PID_FILE="$RUN_DIR/gateway.pid"
CANONICAL_URL="https://localhost/"
VITE_URL="http://localhost:5173"
DIRECT_URL="https://localhost:8888"

# Read one scalar out of the stack: block. Defaults mirror shared/config's
# schema so a config predating this block still launches.
cfg() { # cfg <key> <default>
  awk -v k="  $1:" '$0 ~ "^"k {print $2; exit}' "$CONFIG" 2>/dev/null | tr -d '"' | grep -E '^[0-9]+$' || echo "$2"
}
READY_TIMEOUT_MS="$(cfg readiness_timeout_ms 60000)"
READY_POLL_MS="$(cfg readiness_poll_ms 500)"
DOCKER_WAIT_S="$(cfg docker_wait_s 30)"

die() { printf '\n  ✗ %s\n\n    fix:  %s\n\n' "$1" "$2" >&2; exit 1; }
step() { printf '  · %s\n' "$1"; }

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
    sleep 1; waited=$((waited + 1))
  done
  step "docker daemon up"
}

preflight_config() {
  [ -f "$CONFIG" ] || die "no gateway config at $CONFIG" \
    "cp gateway/config.yaml ~/.sentient/gateway/config/config.yaml  # then add your secrets"
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
preflight_port() { # preflight_port <port> <label>
  local port="$1" label="$2" pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && return 0

  if [ -f "$GATEWAY_PID_FILE" ]; then
    local ours; ours="$(cat "$GATEWAY_PID_FILE")"
    if printf '%s\n' "$pids" | grep -qx "$ours"; then
      step "stopping our previous gateway (pid $ours) on $port"
      kill "$ours" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$ours" 2>/dev/null || return 0
        sleep 0.25
      done
      kill -9 "$ours" 2>/dev/null || true
      return 0
    fi
  fi

  local who; who="$(ps -o comm= -p "$(printf '%s' "$pids" | head -1)" 2>/dev/null || echo unknown)"
  die "port $port ($label) is held by a process we did not start: pid $(printf '%s' "$pids" | head -1) ($who)" \
      "lsof -nP -iTCP:$port -sTCP:LISTEN    # identify it, then stop it yourself"
}

preflight_images() {
  local missing=()
  for img in inbound-proxy ingress-proxy fetch-mcp searxng-mcp ha-mcp ma-mcp; do
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
  curl -skf -o /dev/null --max-time 3 "$1" 2>/dev/null
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
  for p in 80:http 443:https 8888:gateway 5173:vite; do
    preflight_port "${p%%:*}" "${p##*:}"
  done
  preflight_images
  build_webui

  mkdir -p "$RUN_DIR"
  # Kill the whole process group on exit so Ctrl-C takes vite with the gateway.
  # Native addons deliberately survive — launchd does not reap them either, and
  # the next boot's port-settle reclaims them. `stack.sh down` is the full stop.
  trap 'kill 0' EXIT

  ( cd gateway && exec bun --watch src/main.ts ) &
  echo $! > "$GATEWAY_PID_FILE"
  ( exec bun run --filter './gateway/webui' dev ) &

  wait_ready
  printf '\n  ✓ ready\n\n      open        %s\n      hot reload  %s\n      gateway     %s  (diagnostics)\n\n' \
    "$CANONICAL_URL" "$VITE_URL" "$DIRECT_URL"
  wait
}

cmd_down() {
  printf '\n  sentient — stopping the stack\n\n'
  if [ -f "$GATEWAY_PID_FILE" ]; then
    local pid; pid="$(cat "$GATEWAY_PID_FILE")"
    kill "$pid" 2>/dev/null && step "gateway stopped (pid $pid)" || true
    rm -f "$GATEWAY_PID_FILE"
  fi
  # Native addons are NOT reaped by the gateway's shutdown hook, so without this
  # they outlive it holding 8769/8771 and the next launch pays the port-settle
  # timeout per addon reclaiming its own orphan.
  for svc in whisper-stt local-tts; do
    local f="$RUN_DIR/$svc.pid"
    [ -f "$f" ] || continue
    kill "$(cat "$f")" 2>/dev/null && step "$svc stopped" || true
    rm -f "$f"
  done
  docker ps -q --filter 'label=sentient.managed=true' | xargs -r docker stop >/dev/null
  step "docker addons stopped"
  printf '\n'
}

cmd_status() {
  # Probes independently rather than reading the orchestrator's status endpoint:
  # status is most wanted when the gateway is DOWN, which is exactly when that
  # endpoint cannot answer.
  printf '\n  sentient — stack status\n\n'
  docker info >/dev/null 2>&1 && step "docker      up" || step "docker      DOWN"
  probe "$DIRECT_URL/api/v1/health" && step "gateway     ready   $DIRECT_URL" || step "gateway     DOWN"
  probe "$CANONICAL_URL" && step "door        ready   $CANONICAL_URL" || step "door        DOWN"
  curl -sf -o /dev/null --max-time 2 "$VITE_URL" && step "vite        ready   $VITE_URL" || step "vite        DOWN"
  printf '\n'
  docker ps --filter 'label=sentient.managed=true' --format '    {{.Names}}  {{.Status}}'
  printf '\n'
}

case "${1:-up}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  *) die "unknown command: $1" "scripts/stack.sh {up|down|status}" ;;
esac
```

- [ ] **Step 2: Make it executable and wire the npm scripts**

```bash
chmod +x scripts/stack.sh
```

In `package.json`, replace the `dev` script and add two:

```json
    "dev": "bash scripts/stack.sh up",
    "stack:down": "bash scripts/stack.sh down",
    "stack:status": "bash scripts/stack.sh status",
```

- [ ] **Step 3: Exercise the refuse path**

```bash
source scripts/env.sh
python3 -m http.server 8888 >/dev/null 2>&1 &
FOREIGN=$!
bun run dev; echo "exit=$?"
kill $FOREIGN
```

Expected: refuses, names pid `$FOREIGN` and its command, prints the `lsof` line, exits non-zero. **It must not kill the python process** — that is the whole point of the rule.

- [ ] **Step 4: Exercise the happy path**

```bash
source scripts/env.sh
bun run stack:down
bun run dev
```

Expected: preflight lines, then `✓ ready` with three URLs. Open `https://localhost/`, accept the cert warning once, confirm the UI loads.

- [ ] **Step 5: Exercise restart and status**

With the stack up, in a second terminal:

```bash
source scripts/env.sh
bun run stack:status
```

Expected: docker/gateway/door/vite all `ready`, plus the managed container list.

Then re-run `bun run dev` in the first terminal after Ctrl-C — it must reclaim its own gateway pid without complaint.

- [ ] **Step 6: Commit**

```bash
git add scripts/stack.sh package.json
git commit -m "feat(dev): bun run dev launches the whole stack, one URL"
```

---

### Task 12: Health-gate the prod install through 443

Spec §4.9. Today `health.ts` returns 200 as soon as the process is up and the installer probes 8888 directly, so a broken nginx config, a missing bundle, a wrong cert, or broken WS forwarding would all pass and never trigger the rollback that exists for exactly this.

**Files:**
- Modify: `deploy/mac-prod/setup-prod.py`

- [ ] **Step 1: Read the existing probe**

Run: `source scripts/env.sh && sed -n '55,90p;560,600p' deploy/mac-prod/setup-prod.py`
Identify the existing health-probe helper and the post-install call site that decides rollback.

- [ ] **Step 2: Add the edge probe**

Add a second probe beside the existing one, reusing its retry/backoff shape:

```python
def probe_edge(outward_cert: Path, deadline_s: int) -> tuple[bool, str]:
    """GET https://localhost/ through inbound-proxy, verified.

    The 8888 probe proves the BINARY came up. It cannot prove the stack is
    usable: nginx may have a bad config, the bundle may be missing, the outward
    cert may be wrong, and 8888 answers 200 through all three. Since 443 is the
    only port a user ever touches, an install that cannot serve it has not
    succeeded and must roll back.

    TLS is VERIFIED, pinned to the exact certificate the proxy is configured to
    present — the same trust-anchor pattern this installer already uses for the
    8888 probe. Never CERT_NONE: a health gate that accepts any certificate
    cannot tell "the proxy came up" from "something else answered on 443", and
    accepting the wrong cert here is how a broken deploy gets called healthy.

    check_hostname is off because the name is deliberately mismatched: we dial
    localhost while the prod cert names sentient.dev32.io. Chain verification
    against the pinned file still runs, so the identity check is real — it is
    the NAME check that is inapplicable, not the trust check.
    """
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(cafile=str(outward_cert))
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_REQUIRED
    ...
```

`outward_cert` is `inbound_proxy.cert_dir/cert.pem` when that path exists, else `~/.sentient/gateway/certs/cert.pem` — the same fallback `phase-orchestrator.ts` applies in Task 8, so the installer and the gateway agree on which cert is in play. Read it from the operator config rather than hardcoding either path.

Implement the body with the same loop, timeout, and logging the existing 8888 probe uses. Accept any 2xx or 3xx as success — the root path may redirect to a login route.

- [ ] **Step 3: Call it in the health gate**

At the post-install gate, run the 8888 probe first and the 443 probe second. Both must pass before the install is accepted; either failing triggers the existing rollback. Log which one failed — "gateway healthy, edge not" and "gateway not healthy" are different faults with different fixes.

- [ ] **Step 4: Verify the installer still parses and self-checks**

```bash
source scripts/env.sh
python3 -m py_compile deploy/mac-prod/setup-prod.py && echo "compiles"
python3 deploy/mac-prod/setup-prod.py --help
```

Expected: compiles; help prints.

Do **not** run an install against the mini. Prod is observational-only; this change ships and is exercised on the next approved deploy.

- [ ] **Step 5: Commit**

```bash
git add deploy/mac-prod/setup-prod.py
git commit -m "fix(deploy): health-gate the install through 443, not just 8888"
```

---

### Task 13: Doc reconciliation

Spec §4.10. Four documents describe a stack that no longer exists or never did.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `gateway/CLAUDE.md`
- Modify: `deploy/README.md`
- Modify: `docs/superpowers/specs/2026-07-29-native-stack-migration-design.md`

- [ ] **Step 1: Fix the root `CLAUDE.md` running section**

Replace the "Two URLs, and they are not interchangeable" paragraph and the `bun run dev` line with:

```markdown
**Three doors, increasing fidelity.** `https://localhost` is the real one —
inbound-proxy on 443, the gateway serving the built UI behind it, identical to
prod. **All browser smoke goes here.** `http://localhost:5173` is vite, live
source with HMR, for UI iteration. `https://localhost:8888` is the gateway
direct, host-only, for diagnostics.

443 serves the bundle **as of launch**. Vite hot-reloads; 443 does not. Relaunch
to refresh it — which you want before smoking anyway, since smoke exercises the
stack as launched.

**Dev** — from the repo root:

    bun run dev             # preflight + gateway + vite + docker/native addons + proxy
    bun run stack:down      # full stop, including native addons and containers
    bun run stack:status    # what is up, probed independently of the gateway

`bun run dev` sources `scripts/env.sh` itself, builds the web UI, bakes any
missing addon images, and refuses with a runnable fix when it finds something it
must not silently repair. Re-running it against a live stack restarts it.

Ctrl-C stops the gateway and vite. Docker addons keep running (`unless-stopped`,
which is what makes restart fast) and native addons survive too — the gateway's
shutdown hook does not reap them, and the next boot's port-settle reclaims them.
`bun run stack:down` is the explicit full stop.
```

Keep the existing `bun --watch` / never-`--hot` paragraph — it is still correct and still load-bearing.

- [ ] **Step 2: Fix `gateway/CLAUDE.md`**

Its `bun run dev` line now describes only the gateway process. Note that the repo-root `bun run dev` is the whole stack and this one is the gateway alone.

- [ ] **Step 3: Fix `deploy/README.md`**

Two changes:
- The "First launch" section at line 114 promises `https://sentient.dev32.io` (port 443). That is now true — remove the `or https://<host>:8888` alternative, which is no longer reachable from another host.
- The cert paragraph at line 131 currently reads as the single cert story. Rewrite it as the two roles: `~/.data/certs/sentient.dev32.io` is the **outward identity** the proxy presents (set `inbound_proxy.cert_dir` to it), and `~/.sentient/gateway/certs` is the **upstream trust anchor** for the loopback hop, always. Add the renewal note: acme.sh replacing the cert does not reload nginx, so run `docker kill -s HUP sentient-inbound-proxy` after a renewal.

Also add the SAN note from spec §2.6: a browser on a LAN phone gets no microphone unless that host's IP or name is in `tls.hostnames`.

- [ ] **Step 4: Fix the stale `bun --hot` reference**

In `docs/superpowers/specs/2026-07-29-native-stack-migration-design.md`, find the `bun --hot` mention and correct it to `bun --watch`, noting that `gateway/src/main.ts:81-93` refuses hot reload outright because a second in-process supervisor reaps and respawns the first one's children.

- [ ] **Step 5: Verify no stale instructions survive**

```bash
source scripts/env.sh
grep -rn "never open :8888\|never \`:8888\`\|bun --hot" --include='*.md' . | grep -v node_modules
grep -rn "localhost:5173" --include='*.md' . | grep -v node_modules
```

Expected: no result tells a reader to avoid 8888 as a rule or to use `--hot`; every 5173 mention describes it as the HMR side door.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md gateway/CLAUDE.md deploy/README.md docs/superpowers/specs/2026-07-29-native-stack-migration-design.md
git commit -m "docs: three doors, two cert roles, and one launch command"
```

---

### Task 14: Full E2E matrix

Spec §6. **A feature is not done until every smoke case is green.** All cases run against the local dev stack. Prod stays observational.

**Files:**
- Modify: `agents/docs/testing-knowledge.md` (add the reusable cases)

- [ ] **Step 1: Bring up a clean stack**

```bash
source scripts/env.sh
bun run stack:down
docker ps -aq --filter 'label=sentient.managed=true' | xargs -r docker rm -f
bun run dev
```

- [ ] **Step 2: Run the browser cases**

Drive Playwright MCP at `https://localhost/` at 1280×900, then repeat at 390×844 via `browser_resize`. Capture a screenshot and the console/network log per case.

| Case | Action | Green when |
|---|---|---|
| `inbound-https` | GET `https://localhost/` | UI loads; proxy access log 200; gateway static handler hit, not a 404 |
| `inbound-http-redirect` | `curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost/` | `301 https://localhost/`; no gateway hit in its log |
| `inbound-ws` | log in as Ada, send a chat message | reply streams; no reconnect loop; gateway logs a WS open; no upgrade-failure WARN |
| `webui-served-natively` | GET `https://localhost:8888/` | UI loads — proves `webDistDir` resolved (Task 1) |
| `relaunch-refreshes-443` | edit a webui source file; check 5173 then 443; `bun run dev`; check 443 | 5173 updates immediately; 443 only after the relaunch; preflight logs a build each start |

- [ ] **Step 3: Run the non-browser cases**

```bash
source scripts/env.sh

# gateway-not-lan-reachable — the case that proves the security claim
LAN_IP="$(ipconfig getifaddr en0)"
curl -sk --max-time 3 "https://$LAN_IP:8888/api/v1/health" && echo "FAIL: reachable" || echo "PASS: refused"
curl -sk --max-time 3 "https://$LAN_IP/api/v1/health" >/dev/null && echo "PASS: door answers"

# proxy-survives-save
CID_BEFORE="$(docker inspect -f '{{.Id}}' sentient-inbound-proxy)"
touch gateway/src/main.ts
sleep 8
curl -sk -o /dev/null -w 'door: %{http_code}\n' https://localhost/
CID_AFTER="$(docker inspect -f '{{.Id}}' sentient-inbound-proxy)"
[ "$CID_BEFORE" = "$CID_AFTER" ] && echo "PASS: not recreated" || echo "FAIL: recreated"
grep -c 'driver.recreate-skipped' ~/.sentient/gateway/logs/"$(date +%F)".log

# preflight-refuses-foreign-port
python3 -m http.server 8888 >/dev/null 2>&1 & FOREIGN=$!
bun run dev; echo "exit=$? (non-zero expected)"
ps -p $FOREIGN >/dev/null && echo "PASS: foreign process untouched"; kill $FOREIGN

# stack-up-from-cold
bun run stack:down
docker ps -aq --filter 'label=sentient.managed=true' | xargs -r docker rm -f
time bun run dev
```

Green when: the LAN IP on 8888 refuses while the LAN IP on 443 answers; the proxy container id is unchanged across a save and `driver.recreate-skipped` appears in the log; the foreign process is named and left alive; the cold start reaches `✓ ready` and prints all three URLs.

- [ ] **Step 4: Run `fresh-install-wizard`**

```bash
source scripts/env.sh
bun run stack:down
cp ~/.sentient/gateway/install-state.json /tmp/install-state.backup.json
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".sentient/gateway/install-state.json"
d = json.loads(p.read_text()); d["bootstrap_complete"] = False
p.write_text(json.dumps(d, indent=2))
PY
docker ps -aq --filter 'label=sentient.managed=true' | xargs -r docker rm -f
bun run dev
```

Green when: `https://localhost/` serves the wizard; the log shows `boot-reconcile.infra-only` with `inbound-proxy` in it, and **no** capability addon applied before the wizard.

Restore afterwards: `cp /tmp/install-state.backup.json ~/.sentient/gateway/install-state.json`

- [ ] **Step 5: Run `mobile-connects-443`**

Build and install both apps, then drive the Maestro suites:

```bash
source scripts/env.sh
qa/mobile/run-e2e.sh --tags reconnect,settings-voice
```

Green when: both platforms connect on 443 through the proxy, a message round-trips, and no `:8888` dial appears in the `logcat` / `os_log` trail.

If a physical device is unavailable, record this case as deferred in the handover with the exact reason — do not mark it green.

- [ ] **Step 6: Record the reusable cases**

Add `inbound-https`, `inbound-http-redirect`, `inbound-ws`, `gateway-not-lan-reachable`, `proxy-survives-save`, `fresh-install-wizard`, `stack-up-from-cold`, `preflight-refuses-foreign-port` and `relaunch-refreshes-443` to `agents/docs/testing-knowledge.md`, indexed by the surface each exercises.

- [ ] **Step 7: Run the quality gate**

```bash
source scripts/env.sh
bun run ci
```

Expected: lint, typecheck and unit tests all clean.

- [ ] **Step 8: Commit**

```bash
git add agents/docs/testing-knowledge.md
git commit -m "test(e2e): record the inbound-proxy and launcher smoke cases"
```

---

## Self-review

**Spec coverage.** Every §4 "In" item maps to a task: §4.1→T1, §4.2→T8, §4.3→T4, §4.4→T3+T5+T6+T7, §4.5→T9, §4.6→T10, §4.7→T2, §4.8→T11, §4.9→T12, §4.10→T13. Spec §6's matrix is T14. All five §7 open questions are decided in the header table.

**Ordering.** T1, T2, T3 are independent. T4 needs T3's config surface. T5 needs T3. T6 needs T3. T7 needs T3 + T6's `index.ts` edits. T8 needs T3, T4, T5. T9 is independent of the proxy but pointless before T8 (loopback with no door). T10 needs T8 running. T11 needs T8 + T9. T12 and T13 need T8. T14 is last.

**Type consistency.** `infra` and `public_ports` are separate booleans throughout — `infra` is a lifecycle class, `public_ports` an exposure grant, and they are never read as one. `isAllowedPortMapping(entry, allowPublic)` has the same signature at all three call sites. `computeSpecHash(spec)` takes the create-spec, not the service. `resolveWebDistDir()` returns `string | undefined`, matching `StartupConfig.webDistDir`.

**Known gap carried deliberately.** T10's `mobile-connects-443` depends on a physical device; if unavailable it is deferred with a stated reason rather than marked green (spec §6 and the e2e rule both require this to be explicit).
