# Signal Device Pairing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each Sentient user pair their personal Signal account (Note-to-Self mode) via a new Settings > Devices tab, so they can text-chat their family agent from Signal and receive cron-scheduled reminders.

**Architecture:** Hermes ships the Signal adapter, `gateway run` runner, and cron — we add provisioning, lifecycle, and a webui surface only. signal-cli runs as a 4th per-user supervisor program inside the existing `sentient-hermes` overlay container (Java 17 + signal-cli baked into Dockerfile). Pairing flow: webui → gateway API → signal-cli `link` JSON-RPC → QR rendered client-side via JSX SVG rects (no innerHTML) → user scans → gateway finalizes by writing `SIGNAL_*` env vars and starting the per-user `hermes -p u_X gateway run` supervisor program.

**Tech Stack:** Bun/TypeScript gateway, Preact + Vite webui, supervisord (in hermes container), Java 17 + signal-cli (in hermes container), zod schemas in `shared/config`, vitest for unit tests, Playwright MCP for smoke. Tinyproxy egress proxy.

**Spec:** `docs/superpowers/specs/2026-05-10-signal-device-pairing-design.md`

---

## File Structure

### Create

| Path | Responsibility |
|---|---|
| `deploy/hermes-overlay/SIGNAL_CLI_VERSION` | Pinned signal-cli version (single line, parallel to existing `HERMES_VERSION`) |
| `gateway/src/devices/signal/signal-cli-client.ts` | Typed HTTP JSON-RPC client to in-container signal-cli daemon |
| `gateway/src/devices/signal/signal-cli-client.test.ts` | Wire-protocol contract test (JSON-RPC envelope shapes) |
| `gateway/src/devices/signal/pairing-coordinator.ts` | FSM coordinating provisioning → link → finalize → linked / unlink |
| `gateway/src/devices/signal/pairing-coordinator.test.ts` | FSM transition test (timeout, cancel, apply-failure paths) |
| `gateway/src/devices/signal/pending-links.ts` | In-memory per-user pending-link registry with TTL |
| `gateway/src/devices/signal/port-allocator.ts` | Derives `signal_cli_port` from existing `acp_port` |
| `gateway/src/devices/signal/signal-provisioner.ts` | Bridges handlers ↔ supervisor / env / profile (provision, finalize, unpair, cleanup) |
| `gateway/src/profile-store/env-writer.ts` | Atomic `.env` mutation (merge/clear of SIGNAL_* keys) |
| `gateway/src/profile-store/env-writer.test.ts` | Atomic rewrite + preservation contract |
| `gateway/src/api/handlers/devices.ts` | `/api/devices` + `/api/devices/signal/*` HTTP handlers |
| `gateway/webui/src/components/settings/panes/devices-pane.tsx` | Devices settings pane (unpaired/linked states) |
| `gateway/webui/src/components/settings/panes/qr-link-modal.tsx` | QR linking modal (JSX-rendered SVG, no innerHTML) |

### Modify

| Path | Change |
|---|---|
| `gateway/package.json` | Version `1.4.4` → `1.5.0` |
| `gateway/webui/package.json` | Add `qrcode` dependency |
| `shared/config/src/schemas/profile.ts` | Add `devices.signal` schema |
| `gateway/templates/program/program.conf.tmpl` | Add conditional `signal-cli` + `gateway` program blocks |
| `gateway/src/profile-store/profile-renderer.ts` | Pass pairing flag + `signal_cli_port` to template render context; conditionally render new program blocks |
| `gateway/src/profile-store/profile-renderer.test.ts` | Add paired-vs-unpaired render assertions |
| `gateway/templates/profile/hermes-config.yaml.tmpl` | Add conditional `gateway:` + `cron.default_deliver` blocks |
| `gateway/src/apply/orchestrator.ts` | Extend supervisor restart-targets list + healthcheck for signal-cli + gateway programs |
| `gateway/src/system-orchestrator/boot-reconciler.ts` | Verify paired-state consistency (flag vs signal-cli/ dir vs .env) |
| `gateway/src/system-orchestrator/boot-reconciler.test.ts` | Add paired-but-missing-state test |
| `gateway/src/api/router.ts` | Wire new `/api/devices/*` routes |
| `gateway/src/bootstrap/phase-services.ts` | Construct `SignalProvisioner` + pass into router deps |
| `gateway/webui/src/components/settings/settings.tsx` | Add Devices tab between Members and Advanced |
| `gateway/webui/src/components/settings/panes/panes.css` | Add styles for `.devices-pane`, `.qr-modal`, etc. |
| `deploy/hermes-overlay/Dockerfile` | Install Java 17 + signal-cli; bake `JAVA_TOOL_OPTIONS` |
| `gateway/templates/services/egress-proxy/tinyproxy.conf` | `Timeout 600` → `Timeout 0` (no idle kill — preserves long-lived Signal WS) |

---

## Implementation Order

Phase 1 — version bump + Hermes overlay (Tasks 1–3)
Phase 2 — schemas + atomic primitives (Tasks 4–6)
Phase 3 — signal-cli client + pending-links + coordinator (Tasks 7–8)
Phase 4 — renderer + orchestrator + reconciler + proxy fix (Tasks 9–14)
Phase 5 — API handlers + provisioner (Tasks 15–17)
Phase 6 — webui (Tasks 18–21)
Phase 7 — full CI + Playwright smoke + macOS local smoke (Tasks 22–24)

---

### Task 1: Bump gateway version

**Files:**
- Modify: `gateway/package.json`

- [ ] **Step 1: Edit version field**

In `gateway/package.json`, change line 3:

```json
"version": "1.4.4",
```

to:

```json
"version": "1.5.0",
```

- [ ] **Step 2: Commit**

```bash
git add gateway/package.json
git commit -m "chore(gateway): bump version 1.4.4 → 1.5.0 for signal device pairing"
```

---

### Task 2: Pin signal-cli version + add to Hermes overlay Dockerfile

**Files:**
- Create: `deploy/hermes-overlay/SIGNAL_CLI_VERSION`
- Modify: `deploy/hermes-overlay/Dockerfile`

- [ ] **Step 1: Verify the pinned signal-cli version**

Open `https://github.com/AsamK/signal-cli/releases/latest` in a browser. Note the latest stable tag (e.g. `0.13.21`). Use this exact version below.

- [ ] **Step 2: Create the pin file**

Create `deploy/hermes-overlay/SIGNAL_CLI_VERSION` containing only the version number (no `v` prefix, no trailing whitespace except newline):

```
0.13.21
```

- [ ] **Step 3: Extend the Hermes overlay Dockerfile**

Open `deploy/hermes-overlay/Dockerfile`. After the existing `apt-get install` line (the one installing `supervisor`, `patch`, `netcat-openbsd`), insert:

```Dockerfile
ARG SIGNAL_CLI_VERSION

# Java 17 JRE (headless) for signal-cli. Required by signal-cli runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless \
      ca-certificates-java \
      curl \
    && rm -rf /var/lib/apt/lists/*

# signal-cli — pinned tarball from official GitHub release. SIGNAL_CLI_VERSION
# comes via --build-arg from the deploy script (single source of truth in
# deploy/hermes-overlay/SIGNAL_CLI_VERSION).
RUN curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
      | tar -xz -C /opt \
    && ln -sf /opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli /usr/local/bin/signal-cli

# JVM defaults baked into image — apply to every signal-cli JVM child
# supervisord spawns. Headless prevents AWT init; proxy points at the
# existing sentient-egress-proxy so Signal HTTPS traffic flows through
# the audited egress hop.
ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true -Dhttps.proxyHost=sentient-egress-proxy -Dhttps.proxyPort=3128 -Dhttp.nonProxyHosts=localhost|127.0.0.1|sentient-gateway|sentient-stt-service|sentient-ha-mcp|sentient-ma-mcp|sentient-searxng-mcp|sentient-fetch-mcp"

LABEL org.sentient.signal-cli-version=${SIGNAL_CLI_VERSION}
```

- [ ] **Step 4: Verify the build arg pass-through**

Locate `deploy/setup-prod.py` (or whatever invokes `docker build` for the overlay). If it currently passes only `HERMES_VERSION`, add the parallel pass-through reading from `deploy/hermes-overlay/SIGNAL_CLI_VERSION`. The build call should look like:

```bash
docker build \
  --build-arg HERMES_VERSION=$(cat deploy/hermes-overlay/HERMES_VERSION) \
  --build-arg SIGNAL_CLI_VERSION=$(cat deploy/hermes-overlay/SIGNAL_CLI_VERSION) \
  -f deploy/hermes-overlay/Dockerfile \
  -t sentient/hermes:local .
```

Mirror that pattern in setup-prod.py if it lives there.

- [ ] **Step 5: Local Docker build smoke**

From the worktree root:

```bash
docker build \
  --build-arg HERMES_VERSION=$(cat deploy/hermes-overlay/HERMES_VERSION) \
  --build-arg SIGNAL_CLI_VERSION=$(cat deploy/hermes-overlay/SIGNAL_CLI_VERSION) \
  -f deploy/hermes-overlay/Dockerfile \
  -t sentient/hermes:local-signal-test .
```

Expected: build completes. Image ~210 MB larger.

Verify:

```bash
docker run --rm sentient/hermes:local-signal-test bash -c "java -version && which signal-cli && signal-cli --version"
```

Expected:
- Java version mentioning `17` and `OpenJDK Runtime Environment`
- `/usr/local/bin/signal-cli`
- `signal-cli 0.13.21`

- [ ] **Step 6: Commit**

```bash
git add deploy/hermes-overlay/SIGNAL_CLI_VERSION deploy/hermes-overlay/Dockerfile
# Include deploy/setup-prod.py if step 4 needed changes
git commit -m "feat(hermes-overlay): bake Java 17 + signal-cli into image for Signal device pairing"
```

---

### Task 3: Profile schema — add devices.signal

**Files:**
- Modify: `shared/config/src/schemas/profile.ts`

- [ ] **Step 1: Read current schema**

```bash
grep -n "z.object\|persona\|model" shared/config/src/schemas/profile.ts | head -20
```

Locate the v1 profile schema definition.

- [ ] **Step 2: Add the device schemas**

Near other field schemas, add:

```ts
/**
 * Per-platform device pairing state. Phone number (E.164) is PII and lives
 * only in the per-profile .env file; profile yaml stores a masked rendering
 * for display purposes.
 */
export const signalDeviceSchema = z.object({
  paired: z.boolean(),
  // Display-only masked E.164, e.g. "+1•••••1234". Never the raw number.
  account_masked: z.string().optional(),
  linked_at: z.string().datetime().optional(),
});

export const devicesSchema = z.object({
  signal: signalDeviceSchema.optional(),
});
```

In the v1 profile schema object, add the optional `devices` field:

```ts
  devices: devicesSchema.optional(),
```

At the bottom of the file (next to other type exports):

```ts
export type SignalDevice = z.infer<typeof signalDeviceSchema>;
export type Devices = z.infer<typeof devicesSchema>;
```

- [ ] **Step 3: Run typecheck**

```bash
source scripts/env.sh
bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add shared/config/src/schemas/profile.ts
git commit -m "feat(config): add profile.devices.signal schema for pairing state"
```

---

### Task 4: Port allocator — derive signal_cli_port

**Files:**
- Create: `gateway/src/devices/signal/port-allocator.ts`

- [ ] **Step 1: Implement**

Create `gateway/src/devices/signal/port-allocator.ts`:

```ts
/**
 * Signal-cli runs as a per-user supervisor program inside the hermes overlay
 * container, bound to 127.0.0.1 on a port derived from the user's allocated
 * ACP port. Loopback-only — never published outside the container.
 *
 * Layout per user index N:
 *   acp_port        = 8650 + N
 *   dashboard_port  = acp_port + 1000   (existing)
 *   signal_cli_port = acp_port + 2000   (new)
 */
export function deriveSignalCliPort(acpPort: number): number {
  return acpPort + 2000;
}
```

- [ ] **Step 2: Typecheck**

```bash
source scripts/env.sh
bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/devices/signal/port-allocator.ts
git commit -m "feat(devices/signal): port allocator deriving signal_cli_port from acp_port"
```

---

### Task 5: env-writer module — TDD

**Files:**
- Create: `gateway/src/profile-store/env-writer.test.ts`
- Create: `gateway/src/profile-store/env-writer.ts`

- [ ] **Step 1: Write failing tests**

Create `gateway/src/profile-store/env-writer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSignalEnv, mergeSignalEnv } from "./env-writer";

describe("env-writer", () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envwriter-"));
    envPath = join(dir, ".env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("mergeSignalEnv adds SIGNAL_* keys to empty file", async () => {
    writeFileSync(envPath, "");
    await mergeSignalEnv(envPath, {
      httpUrl: "http://127.0.0.1:10650",
      account: "+15551234567",
      allowedUsers: "+15551234567",
    });
    const out = readFileSync(envPath, "utf8");
    expect(out).toContain("SIGNAL_HTTP_URL=http://127.0.0.1:10650");
    expect(out).toContain("SIGNAL_ACCOUNT=+15551234567");
    expect(out).toContain("SIGNAL_ALLOWED_USERS=+15551234567");
    expect(out).toContain("SIGNAL_ALLOW_ALL_USERS=false");
  });

  test("mergeSignalEnv preserves unrelated lines", async () => {
    writeFileSync(envPath, "FOO=bar\nBAZ=qux\n");
    await mergeSignalEnv(envPath, {
      httpUrl: "http://127.0.0.1:10650",
      account: "+15551234567",
      allowedUsers: "+15551234567",
    });
    const out = readFileSync(envPath, "utf8");
    expect(out).toContain("FOO=bar");
    expect(out).toContain("BAZ=qux");
    expect(out).toContain("SIGNAL_HTTP_URL=");
  });

  test("mergeSignalEnv overwrites existing SIGNAL_* keys, not duplicates", async () => {
    writeFileSync(envPath, "SIGNAL_ACCOUNT=+10000000000\nOTHER=stay\n");
    await mergeSignalEnv(envPath, {
      httpUrl: "http://127.0.0.1:10650",
      account: "+15551234567",
      allowedUsers: "+15551234567",
    });
    const out = readFileSync(envPath, "utf8");
    const matches = out.match(/^SIGNAL_ACCOUNT=/gm);
    expect(matches).toHaveLength(1);
    expect(out).toContain("SIGNAL_ACCOUNT=+15551234567");
    expect(out).toContain("OTHER=stay");
  });

  test("clearSignalEnv removes only SIGNAL_* keys", async () => {
    writeFileSync(
      envPath,
      "FOO=bar\nSIGNAL_HTTP_URL=http://x\nSIGNAL_ACCOUNT=+1\nSIGNAL_ALLOWED_USERS=+1\nSIGNAL_ALLOW_ALL_USERS=false\nBAZ=qux\n",
    );
    await clearSignalEnv(envPath);
    const out = readFileSync(envPath, "utf8");
    expect(out).not.toContain("SIGNAL_");
    expect(out).toContain("FOO=bar");
    expect(out).toContain("BAZ=qux");
  });

  test("mergeSignalEnv on missing file creates it", async () => {
    await mergeSignalEnv(envPath, {
      httpUrl: "http://127.0.0.1:10650",
      account: "+15551234567",
      allowedUsers: "+15551234567",
    });
    const out = readFileSync(envPath, "utf8");
    expect(out).toContain("SIGNAL_ACCOUNT=+15551234567");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
source scripts/env.sh
cd gateway && bun run test src/profile-store/env-writer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement env-writer**

Create `gateway/src/profile-store/env-writer.ts`:

```ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export interface SignalEnvValues {
  httpUrl: string;
  account: string;
  allowedUsers: string;
}

const SIGNAL_KEYS = [
  "SIGNAL_HTTP_URL",
  "SIGNAL_ACCOUNT",
  "SIGNAL_ALLOWED_USERS",
  "SIGNAL_ALLOW_ALL_USERS",
];

function readLinesOrEmpty(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function stripSignalLines(lines: string[]): string[] {
  return lines.filter((line) => {
    const eq = line.indexOf("=");
    if (eq < 0) return true;
    const key = line.slice(0, eq);
    return !SIGNAL_KEYS.includes(key);
  });
}

function writeAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.env.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function mergeSignalEnv(path: string, values: SignalEnvValues): Promise<void> {
  const preserved = stripSignalLines(readLinesOrEmpty(path));
  const signalLines = [
    `SIGNAL_HTTP_URL=${values.httpUrl}`,
    `SIGNAL_ACCOUNT=${values.account}`,
    `SIGNAL_ALLOWED_USERS=${values.allowedUsers}`,
    `SIGNAL_ALLOW_ALL_USERS=false`,
  ];
  const all = [...preserved, ...signalLines];
  writeAtomic(path, `${all.join("\n")}\n`);
}

export async function clearSignalEnv(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const preserved = stripSignalLines(readLinesOrEmpty(path));
  writeAtomic(path, preserved.length > 0 ? `${preserved.join("\n")}\n` : "");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd gateway && bun run test src/profile-store/env-writer.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/profile-store/env-writer.ts gateway/src/profile-store/env-writer.test.ts
git commit -m "feat(profile-store): env-writer for atomic SIGNAL_* env mutations"
```

---

### Task 6: pending-links registry

**Files:**
- Create: `gateway/src/devices/signal/pending-links.ts`

Pure utility — no test (per testing rules — no protocol/contract surface).

- [ ] **Step 1: Implement pending-links**

Create `gateway/src/devices/signal/pending-links.ts`:

```ts
/**
 * In-memory registry of pending Signal pair operations, keyed by userId.
 * One pending link per user at a time. TTL-bound; expired entries are
 * cleaned lazily on lookup.
 */
export interface PendingLink {
  readonly userId: string;
  readonly uri: string;
  readonly expiresAt: number; // epoch ms
  readonly nonce: string;
}

export class PendingLinks {
  private readonly byUser = new Map<string, PendingLink>();

  put(link: PendingLink): void {
    this.byUser.set(link.userId, link);
  }

  get(userId: string): PendingLink | undefined {
    const entry = this.byUser.get(userId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.byUser.delete(userId);
      return undefined;
    }
    return entry;
  }

  has(userId: string): boolean {
    return this.get(userId) !== undefined;
  }

  clear(userId: string): boolean {
    return this.byUser.delete(userId);
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
source scripts/env.sh
bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/devices/signal/pending-links.ts
git commit -m "feat(devices/signal): pending-links in-memory registry with TTL"
```

---

### Task 7: signal-cli-client — TDD

**Files:**
- Create: `gateway/src/devices/signal/signal-cli-client.test.ts`
- Create: `gateway/src/devices/signal/signal-cli-client.ts`

signal-cli daemon HTTP mode exposes JSON-RPC 2.0 at `POST /api/v1/rpc`. Methods used: `version`, `startLink`, `listAccounts`, `removeAccount`. **The exact method names and param shapes MUST be verified against the pinned `signal-cli ${SIGNAL_CLI_VERSION}` JSON-RPC reference (`https://github.com/AsamK/signal-cli/wiki/JSON-RPC-service`) at implementation time.** If upstream differs, adjust both client and tests together in the same commit.

- [ ] **Step 1: Write failing tests**

Create `gateway/src/devices/signal/signal-cli-client.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { SignalCliClient } from "./signal-cli-client";

interface CapturedCall {
  url: string;
  body: unknown;
}

function makeFetchStub(responses: Array<unknown>): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const stubFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const resp = responses[i++];
    return {
      ok: true,
      status: 200,
      json: async () => resp,
      text: async () => JSON.stringify(resp),
    } as Response;
  }) as typeof fetch;
  return { fetch: stubFetch, calls };
}

describe("SignalCliClient", () => {
  test("health() returns true when daemon answers version", async () => {
    const { fetch } = makeFetchStub([
      { jsonrpc: "2.0", id: 1, result: { version: "0.13.21" } },
    ]);
    const client = new SignalCliClient("http://127.0.0.1:10650", fetch);
    expect(await client.health()).toBe(true);
  });

  test("startLink posts startLink with deviceName as name param", async () => {
    const { fetch, calls } = makeFetchStub([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { deviceLinkUri: "sgnl://linkdevice?uuid=abc&pub_key=xyz" },
      },
    ]);
    const client = new SignalCliClient("http://127.0.0.1:10650", fetch);
    const result = await client.startLink({ deviceName: "Sentient-u_abc" });
    expect(calls[0].url).toContain("/api/v1/rpc");
    const body = calls[0].body as { method: string; params: { name: string } };
    expect(body.method).toBe("startLink");
    expect(body.params.name).toBe("Sentient-u_abc");
    expect(result.uri).toBe("sgnl://linkdevice?uuid=abc&pub_key=xyz");
  });

  test("listAccounts returns list of account E.164 strings", async () => {
    const { fetch } = makeFetchStub([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { accounts: [{ number: "+15551234567" }] },
      },
    ]);
    const client = new SignalCliClient("http://127.0.0.1:10650", fetch);
    const accounts = await client.listAccounts();
    expect(accounts).toEqual(["+15551234567"]);
  });

  test("listAccounts returns empty array when no accounts", async () => {
    const { fetch } = makeFetchStub([
      { jsonrpc: "2.0", id: 1, result: { accounts: [] } },
    ]);
    const client = new SignalCliClient("http://127.0.0.1:10650", fetch);
    expect(await client.listAccounts()).toEqual([]);
  });

  test("removeAccount posts removeAccount with account param", async () => {
    const { fetch, calls } = makeFetchStub([
      { jsonrpc: "2.0", id: 1, result: null },
    ]);
    const client = new SignalCliClient("http://127.0.0.1:10650", fetch);
    await client.removeAccount("+15551234567");
    const body = calls[0].body as { method: string; params: { account: string } };
    expect(body.method).toBe("removeAccount");
    expect(body.params.account).toBe("+15551234567");
  });

  test("rpc throws on JSON-RPC error envelope", async () => {
    const { fetch } = makeFetchStub([
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "device not found" },
      },
    ]);
    const client = new SignalCliClient("http://127.0.0.1:10650", fetch);
    await expect(client.listAccounts()).rejects.toThrow("device not found");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
source scripts/env.sh
cd gateway && bun run test src/devices/signal/signal-cli-client.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement signal-cli-client**

Create `gateway/src/devices/signal/signal-cli-client.ts`:

```ts
/**
 * HTTP JSON-RPC client to a per-user signal-cli daemon running on 127.0.0.1
 * inside the hermes overlay container. signal-cli's daemon HTTP mode exposes
 * JSON-RPC 2.0 at POST /api/v1/rpc.
 *
 * Method names and param shapes are pinned against signal-cli v0.13.x. Verify
 * against the upstream JSON-RPC reference at the pinned version before merge:
 *   https://github.com/AsamK/signal-cli/wiki/JSON-RPC-service
 */
import { createLogger } from "../../logging/logger";

const log = createLogger(["sentient", "devices", "signal", "client"]);

export interface StartLinkParams {
  deviceName: string;
}

export interface StartLinkResult {
  uri: string;
}

export class SignalCliClient {
  private nextId = 1;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    fetchFn: typeof fetch = fetch,
  ) {
    this.fetchFn = fetchFn;
  }

  async health(): Promise<boolean> {
    try {
      await this.rpc<{ version: string }>("version", {});
      return true;
    } catch (err) {
      log.debug("health-check-failed", { error: String(err) });
      return false;
    }
  }

  async startLink(params: StartLinkParams): Promise<StartLinkResult> {
    const result = await this.rpc<{ deviceLinkUri: string }>("startLink", {
      name: params.deviceName,
    });
    return { uri: result.deviceLinkUri };
  }

  async listAccounts(): Promise<string[]> {
    const result = await this.rpc<{ accounts: Array<{ number: string }> }>(
      "listAccounts",
      {},
    );
    return result.accounts.map((a) => a.number);
  }

  async removeAccount(account: string): Promise<void> {
    await this.rpc("removeAccount", { account });
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const resp = await this.fetchFn(`${this.baseUrl}/api/v1/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!resp.ok) {
      throw new Error(`signal-cli HTTP ${resp.status}: ${await resp.text()}`);
    }
    const envelope = (await resp.json()) as {
      result?: T;
      error?: { code: number; message: string };
    };
    if (envelope.error) {
      throw new Error(`signal-cli rpc error: ${envelope.error.message}`);
    }
    return envelope.result as T;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd gateway && bun run test src/devices/signal/signal-cli-client.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/devices/signal/signal-cli-client.ts gateway/src/devices/signal/signal-cli-client.test.ts
git commit -m "feat(devices/signal): JSON-RPC client wrapping signal-cli daemon HTTP API"
```

---

### Task 8: pairing-coordinator FSM — TDD

**Files:**
- Create: `gateway/src/devices/signal/pairing-coordinator.test.ts`
- Create: `gateway/src/devices/signal/pairing-coordinator.ts`

States: `idle` → `provisioning` → `linking` → `awaitingScan` → `finalizing` → `linked`. Failure / cancel branches go to `failed` / `idle`. Exhaustive transition test per testing rules.

- [ ] **Step 1: Write failing tests**

Create `gateway/src/devices/signal/pairing-coordinator.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PairingCoordinator } from "./pairing-coordinator";
import type { SignalCliClient } from "./signal-cli-client";

function mockClient(overrides: Partial<SignalCliClient> = {}): SignalCliClient {
  return {
    health: vi.fn(async () => true),
    startLink: vi.fn(async () => ({ uri: "sgnl://link?abc" })),
    listAccounts: vi.fn(async () => []),
    removeAccount: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SignalCliClient;
}

interface CoordinatorDeps {
  provisionSignalCli: () => Promise<void>;
  waitForHealth: () => Promise<void>;
  finalizePair: (account: string) => Promise<void>;
  cleanupOnFail: () => Promise<void>;
  client: SignalCliClient;
  now: () => number;
}

function makeDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    provisionSignalCli: vi.fn(async () => undefined),
    waitForHealth: vi.fn(async () => undefined),
    finalizePair: vi.fn(async () => undefined),
    cleanupOnFail: vi.fn(async () => undefined),
    client: mockClient(),
    now: () => 1_000_000,
    ...overrides,
  };
}

describe("PairingCoordinator", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test("startPair: idle → linked on happy path", async () => {
    const deps = makeDeps({
      client: mockClient({
        listAccounts: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(["+15551234567"]),
      }),
    });
    const coord = new PairingCoordinator("u_abc", deps);
    const linkPromise = coord.startPair();
    await vi.advanceTimersByTimeAsync(0);
    expect(coord.state).toBe("awaitingScan");

    await vi.advanceTimersByTimeAsync(2000);
    await linkPromise;
    expect(coord.state).toBe("linked");
    expect(deps.finalizePair).toHaveBeenCalledWith("+15551234567");
  });

  test("startPair: cancel during awaitingScan → idle, no finalizePair", async () => {
    const deps = makeDeps();
    const coord = new PairingCoordinator("u_abc", deps);
    void coord.startPair();
    await vi.advanceTimersByTimeAsync(0);
    expect(coord.state).toBe("awaitingScan");

    await coord.cancel();
    expect(coord.state).toBe("idle");
    expect(deps.finalizePair).not.toHaveBeenCalled();
    expect(deps.cleanupOnFail).toHaveBeenCalled();
  });

  test("startPair: 5-minute timeout while awaitingScan → failed", async () => {
    const deps = makeDeps();
    const coord = new PairingCoordinator("u_abc", deps);
    void coord.startPair();
    await vi.advanceTimersByTimeAsync(0);
    expect(coord.state).toBe("awaitingScan");

    await vi.advanceTimersByTimeAsync(301_000);
    expect(coord.state).toBe("failed");
    expect(coord.error).toContain("expired");
  });

  test("startPair: provisioning failure → failed with cleanup", async () => {
    const deps = makeDeps({
      provisionSignalCli: vi.fn(async () => {
        throw new Error("supervisor reread failed");
      }),
    });
    const coord = new PairingCoordinator("u_abc", deps);
    await coord.startPair();
    expect(coord.state).toBe("failed");
    expect(deps.cleanupOnFail).toHaveBeenCalled();
  });

  test("startPair: finalize failure → failed with cleanup", async () => {
    const deps = makeDeps({
      client: mockClient({
        listAccounts: vi.fn().mockResolvedValue(["+15551234567"]),
      }),
      finalizePair: vi.fn(async () => {
        throw new Error("apply failed");
      }),
    });
    const coord = new PairingCoordinator("u_abc", deps);
    void coord.startPair();
    await vi.advanceTimersByTimeAsync(2000);
    expect(coord.state).toBe("failed");
    expect(deps.cleanupOnFail).toHaveBeenCalled();
  });

  test("getUri returns current uri only during awaitingScan", async () => {
    const deps = makeDeps();
    const coord = new PairingCoordinator("u_abc", deps);
    expect(coord.getUri()).toBeUndefined();
    void coord.startPair();
    await vi.advanceTimersByTimeAsync(0);
    expect(coord.getUri()).toBe("sgnl://link?abc");
  });

  test("cannot startPair while not idle", async () => {
    const deps = makeDeps();
    const coord = new PairingCoordinator("u_abc", deps);
    void coord.startPair();
    await vi.advanceTimersByTimeAsync(0);
    await expect(coord.startPair()).rejects.toThrow(/in progress|conflict/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
source scripts/env.sh
cd gateway && bun run test src/devices/signal/pairing-coordinator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement pairing-coordinator**

Create `gateway/src/devices/signal/pairing-coordinator.ts`:

```ts
import type { SignalCliClient } from "./signal-cli-client";
import { createLogger } from "../../logging/logger";

const log = createLogger(["sentient", "devices", "signal", "coordinator"]);

export type PairingState =
  | "idle"
  | "provisioning"
  | "linking"
  | "awaitingScan"
  | "finalizing"
  | "linked"
  | "failed";

const LINK_TTL_MS = 5 * 60 * 1000;
const SCAN_POLL_INTERVAL_MS = 2_000;

export interface PairingDeps {
  provisionSignalCli: () => Promise<void>;
  waitForHealth: () => Promise<void>;
  finalizePair: (account: string) => Promise<void>;
  cleanupOnFail: () => Promise<void>;
  client: SignalCliClient;
  now: () => number;
}

export class PairingCoordinator {
  private _state: PairingState = "idle";
  private _uri: string | undefined;
  private _error: string | undefined;
  private _expiresAt: number | undefined;
  private _pollTimer: ReturnType<typeof setInterval> | undefined;
  private _expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private _accountsBefore: Set<string> = new Set();

  constructor(private readonly userId: string, private readonly deps: PairingDeps) {}

  get state(): PairingState { return this._state; }
  get error(): string | undefined { return this._error; }
  getUri(): string | undefined {
    return this._state === "awaitingScan" ? this._uri : undefined;
  }
  get expiresAt(): number | undefined { return this._expiresAt; }

  async startPair(): Promise<void> {
    if (this._state !== "idle" && this._state !== "failed") {
      throw new Error(`pairing in progress (state=${this._state})`);
    }
    this._error = undefined;
    log.info("pair-start", { userId: this.userId });

    this._state = "provisioning";
    try {
      await this.deps.provisionSignalCli();
      await this.deps.waitForHealth();
    } catch (err) {
      await this.failWith(`provisioning failed: ${String(err)}`);
      return;
    }

    this._state = "linking";
    try {
      this._accountsBefore = new Set(await this.deps.client.listAccounts());
      const { uri } = await this.deps.client.startLink({
        deviceName: `Sentient-${this.userId}`,
      });
      this._uri = uri;
      this._expiresAt = this.deps.now() + LINK_TTL_MS;
    } catch (err) {
      await this.failWith(`startLink failed: ${String(err)}`);
      return;
    }

    this._state = "awaitingScan";
    this.beginScanPolling();
  }

  async cancel(): Promise<void> {
    if (this._state === "idle" || this._state === "linked") return;
    this.stopTimers();
    await this.deps.cleanupOnFail();
    this._state = "idle";
    this._uri = undefined;
    this._expiresAt = undefined;
  }

  private beginScanPolling(): void {
    this._pollTimer = setInterval(() => {
      void this.pollOnce();
    }, SCAN_POLL_INTERVAL_MS);
    this._expiryTimer = setTimeout(() => {
      void this.failWith("link uri expired");
    }, LINK_TTL_MS);
  }

  private async pollOnce(): Promise<void> {
    if (this._state !== "awaitingScan") return;
    let current: string[];
    try {
      current = await this.deps.client.listAccounts();
    } catch (err) {
      log.warn("listAccounts-failed", { error: String(err) });
      return;
    }
    const fresh = current.find((acc) => !this._accountsBefore.has(acc));
    if (!fresh) return;

    this.stopTimers();
    this._state = "finalizing";
    try {
      await this.deps.finalizePair(fresh);
      this._state = "linked";
    } catch (err) {
      await this.failWith(`finalize failed: ${String(err)}`);
    }
  }

  private async failWith(reason: string): Promise<void> {
    log.warn("pair-failed", { userId: this.userId, reason });
    this.stopTimers();
    this._state = "failed";
    this._error = reason;
    try { await this.deps.cleanupOnFail(); } catch { /* swallow */ }
  }

  private stopTimers(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
    if (this._expiryTimer) {
      clearTimeout(this._expiryTimer);
      this._expiryTimer = undefined;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd gateway && bun run test src/devices/signal/pairing-coordinator.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/devices/signal/pairing-coordinator.ts gateway/src/devices/signal/pairing-coordinator.test.ts
git commit -m "feat(devices/signal): pairing-coordinator FSM with timeout + cancel + cleanup"
```

---

### Task 9: Extend supervisor program template

**Files:**
- Modify: `gateway/templates/program/program.conf.tmpl`

The template uses `{{userId}}`, `{{port}}`, `{{dashboardPort}}`, `{{hermesHome}}`, `{{timezone}}`, `{{env_block}}`, `{{token}}`. Add `{{signalCliPort}}` and a `{{#signalPaired}}…{{/signalPaired}}` conditional.

- [ ] **Step 1: Inspect current template**

```bash
cat gateway/templates/program/program.conf.tmpl | tail -40
```

Verify it ends with the `[program:hermes-{{userId}}-dashboard]` block.

- [ ] **Step 2: Append the new conditional blocks**

At the very end of `gateway/templates/program/program.conf.tmpl`, append:

```
{{#signalPaired}}

[program:hermes-{{userId}}-signal-cli]
; signal-cli daemon (Java) bound to 127.0.0.1 on a per-user loopback port.
; Loopback-only — never reachable outside the hermes container.
; --config holds account state (linked-device keys, message store); bind-mounted
; from the host so it survives container/image rebuild and apply.
command=signal-cli --config {{hermesHome}}/signal-cli --service-environment LIVE daemon --http 127.0.0.1:{{signalCliPort}}
autostart=true
autorestart=true
startretries=5
stopwaitsecs=30
stderr_logfile={{hermesHome}}/signal-cli.err.log
stdout_logfile={{hermesHome}}/signal-cli.out.log
environment=
  TZ="{{timezone}}",
  XDG_DATA_HOME="{{hermesHome}}/signal-cli"

[program:hermes-{{userId}}-gateway]
; Per-profile Hermes IM-platform runner. Boots whatever platforms have env
; configured in the profile's .env file. For Sentient v1 that's Signal only.
; Retries on its own loop until SIGNAL_HTTP_URL responds — so program-start
; ordering vs signal-cli is not enforced by supervisord.
command=hermes -p {{userId}} gateway run
autostart=true
autorestart=true
startretries=5
startsecs=10
stopwaitsecs=10
stderr_logfile={{hermesHome}}/gateway.err.log
stdout_logfile={{hermesHome}}/gateway.out.log
environment=
  HERMES_HOME="{{hermesHome}}",
  TZ="{{timezone}}"
{{/signalPaired}}
```

- [ ] **Step 3: Commit**

```bash
git add gateway/templates/program/program.conf.tmpl
git commit -m "feat(templates): conditional signal-cli + gateway supervisor programs per paired user"
```

---

### Task 10: Profile renderer — pass signal context to supervisor template

**Files:**
- Modify: `gateway/src/profile-store/profile-renderer.ts`
- Modify: `gateway/src/profile-store/profile-renderer.test.ts`

- [ ] **Step 1: Locate the supervisor render function**

```bash
grep -n "program.conf.tmpl\|renderProgram\|signalPaired\|dashboardPort" gateway/src/profile-store/profile-renderer.ts | head -10
```

Note the function that loads `program/program.conf.tmpl` and the local variable names for its context.

- [ ] **Step 2: Import port deriver**

At the top of `profile-renderer.ts`, add:

```ts
import { deriveSignalCliPort } from "../devices/signal/port-allocator";
```

- [ ] **Step 3: Extend the template context**

Inside the function that builds the context for `program.conf.tmpl`, add the two new keys when building the context. Adapt to the local variable names in the actual code:

```ts
const signalPaired = profile.devices?.signal?.paired === true;
const signalCliPort = deriveSignalCliPort(acpPort);

const ctx = {
  userId,
  port: acpPort,
  dashboardPort,
  hermesHome,
  timezone,
  env_block: envBlock,
  token,
  // NEW:
  signalPaired,
  signalCliPort,
};
```

- [ ] **Step 4: Extend renderer tests**

Open `gateway/src/profile-store/profile-renderer.test.ts`. Find an existing test that renders the supervisor conf. Add two sibling tests:

```ts
test("renders only acp + dashboard programs for unpaired user", () => {
  const out = renderSupervisorConf({
    profile: { /* existing minimal profile, no devices field */ },
    /* ... existing args matching the actual signature ... */
  });
  expect(out).toContain("[program:hermes-u_abc-acp]");
  expect(out).toContain("[program:hermes-u_abc-dashboard]");
  expect(out).not.toContain("[program:hermes-u_abc-signal-cli]");
  expect(out).not.toContain("[program:hermes-u_abc-gateway]");
});

test("renders all 4 programs for paired user", () => {
  const out = renderSupervisorConf({
    profile: {
      /* existing minimal profile + */
      devices: { signal: { paired: true, account_masked: "+1•••••1234" } },
    },
    /* ... existing args ... */
  });
  expect(out).toContain("[program:hermes-u_abc-acp]");
  expect(out).toContain("[program:hermes-u_abc-dashboard]");
  expect(out).toContain("[program:hermes-u_abc-signal-cli]");
  expect(out).toContain("[program:hermes-u_abc-gateway]");
  expect(out).toContain("127.0.0.1:10650"); // derived port for first user
});
```

Adapt scaffolding to match the local `renderSupervisorConf` signature and existing fixtures.

- [ ] **Step 5: Run tests**

```bash
source scripts/env.sh
cd gateway && bun run test src/profile-store/profile-renderer.test.ts
```

Expected: existing tests pass + 2 new tests pass.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/profile-store/profile-renderer.ts gateway/src/profile-store/profile-renderer.test.ts
git commit -m "feat(profile-store): renderer emits 4 supervisor programs when signal is paired"
```

---

### Task 11: Hermes config.yaml template — gateway + cron blocks

**Files:**
- Modify: `gateway/templates/profile/hermes-config.yaml.tmpl`
- Modify: `gateway/src/profile-store/profile-renderer.ts`
- Modify: `gateway/src/profile-store/profile-renderer.test.ts`

- [ ] **Step 1: Inspect hermes-config template**

```bash
cat gateway/templates/profile/hermes-config.yaml.tmpl
```

- [ ] **Step 2: Append conditional gateway + cron blocks**

At the end of the file:

```yaml
{{#signalPaired}}
gateway:
  platforms:
    signal:
      enabled: true
      extra:
        # Disable Hermes' built-in DM pairing-code surface (stranger approval).
        # Combined with SIGNAL_ALLOWED_USERS = own E.164, only the user's own
        # account can DM the bot — no stranger-pairing attack surface.
        unauthorized_dm_behavior: ignore
  unauthorized_dm_behavior: ignore
cron:
  default_deliver: signal
{{/signalPaired}}
```

- [ ] **Step 3: Wire signalPaired into hermes-config render context**

In `profile-renderer.ts`, find the function that renders `hermes-config.yaml.tmpl`. Add `signalPaired` to its context (same deriviation as Task 10):

```ts
const signalPaired = profile.devices?.signal?.paired === true;
const hermesConfigCtx = {
  /* ... existing fields ... */
  signalPaired,
};
```

- [ ] **Step 4: Extend renderer tests for hermes-config**

In `gateway/src/profile-store/profile-renderer.test.ts`:

```ts
test("hermes config.yaml omits gateway+cron blocks when unpaired", () => {
  const out = renderHermesConfig({
    profile: { /* unpaired profile */ },
    /* ... */
  });
  expect(out).not.toContain("gateway:");
  expect(out).not.toContain("default_deliver:");
});

test("hermes config.yaml includes gateway+cron blocks when paired", () => {
  const out = renderHermesConfig({
    profile: { /* + devices.signal.paired=true */ },
    /* ... */
  });
  expect(out).toContain("gateway:");
  expect(out).toContain("signal:");
  expect(out).toContain("unauthorized_dm_behavior: ignore");
  expect(out).toContain("default_deliver: signal");
});
```

Adapt to actual `renderHermesConfig` function name and signature.

- [ ] **Step 5: Run tests**

```bash
source scripts/env.sh
cd gateway && bun run test src/profile-store/profile-renderer.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add gateway/templates/profile/hermes-config.yaml.tmpl gateway/src/profile-store/profile-renderer.ts gateway/src/profile-store/profile-renderer.test.ts
git commit -m "feat(profile-store): render gateway.platforms.signal + cron.default_deliver when paired"
```

---

### Task 12: Apply orchestrator — extend restart targets + healthcheck

**Files:**
- Modify: `gateway/src/apply/orchestrator.ts`

- [ ] **Step 1: Read current orchestrator**

```bash
cat gateway/src/apply/orchestrator.ts
```

Identify the supervisor restart target list and the healthcheck step.

- [ ] **Step 2: Extend restart targets based on paired flag**

In the function that builds the restart-target list, add:

```ts
const signalPaired = profile.devices?.signal?.paired === true;
const targets = [
  `hermes-${userId}-acp`,
  `hermes-${userId}-dashboard`,
  ...(signalPaired
    ? [`hermes-${userId}-signal-cli`, `hermes-${userId}-gateway`]
    : []),
];
```

- [ ] **Step 3: Extend healthcheck**

In `pollUntilHealthy` (or whatever the local function is named):

```ts
if (signalPaired) {
  const status = await supervisord.status([
    `hermes-${userId}-signal-cli`,
    `hermes-${userId}-gateway`,
  ]);
  for (const { name, state } of status) {
    if (state !== "RUNNING") {
      throw new Error(`apply healthcheck failed: ${name} not RUNNING (state=${state})`);
    }
  }
}
```

Adapt to the actual supervisord client API (look at how the existing acp/dashboard healthcheck is done).

- [ ] **Step 4: Run existing orchestrator test**

```bash
source scripts/env.sh
cd gateway && bun run test src/apply/orchestrator.test.ts
```

Expected: existing tests still pass. The paired path is exercised by Task 8's FSM tests and Task 23's smoke.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/apply/orchestrator.ts
git commit -m "feat(apply): include signal-cli + gateway in restart targets + healthcheck when paired"
```

---

### Task 13: Boot reconciler — paired-state consistency

**Files:**
- Modify: `gateway/src/system-orchestrator/boot-reconciler.ts`
- Modify: `gateway/src/system-orchestrator/boot-reconciler.test.ts`

- [ ] **Step 1: Read current boot-reconciler**

```bash
cat gateway/src/system-orchestrator/boot-reconciler.ts
```

- [ ] **Step 2: Write failing tests**

In `gateway/src/system-orchestrator/boot-reconciler.test.ts`, add:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileSignalPaired } from "./boot-reconciler";

test("reconcile clears signal.paired when signal-cli/ dir is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  try {
    const profilesDir = join(dir, "profiles");
    mkdirSync(join(profilesDir, "u_abc"), { recursive: true });
    writeFileSync(
      join(profilesDir, "u_abc", ".env"),
      "SIGNAL_HTTP_URL=http://127.0.0.1:10650\nSIGNAL_ACCOUNT=+15551234567\n",
    );
    const profile = {
      userId: "u_abc",
      devices: { signal: { paired: true, account_masked: "+1•••••4567" } },
    };
    const reconciled = await reconcileSignalPaired(profile, profilesDir);
    expect(reconciled.devices?.signal?.paired).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile clears signal.paired when SIGNAL_ACCOUNT missing from .env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  try {
    const profilesDir = join(dir, "profiles");
    mkdirSync(join(profilesDir, "u_abc", "signal-cli"), { recursive: true });
    writeFileSync(join(profilesDir, "u_abc", ".env"), "FOO=bar\n");
    const profile = {
      userId: "u_abc",
      devices: { signal: { paired: true, account_masked: "+1•••••4567" } },
    };
    const reconciled = await reconcileSignalPaired(profile, profilesDir);
    expect(reconciled.devices?.signal?.paired).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile leaves consistent paired state untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  try {
    const profilesDir = join(dir, "profiles");
    mkdirSync(join(profilesDir, "u_abc", "signal-cli"), { recursive: true });
    writeFileSync(
      join(profilesDir, "u_abc", ".env"),
      "SIGNAL_HTTP_URL=http://127.0.0.1:10650\nSIGNAL_ACCOUNT=+15551234567\n",
    );
    const profile = {
      userId: "u_abc",
      devices: { signal: { paired: true, account_masked: "+1•••••4567" } },
    };
    const reconciled = await reconcileSignalPaired(profile, profilesDir);
    expect(reconciled.devices?.signal?.paired).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
source scripts/env.sh
cd gateway && bun run test src/system-orchestrator/boot-reconciler.test.ts
```

Expected: FAIL — `reconcileSignalPaired` not exported.

- [ ] **Step 4: Implement reconcileSignalPaired**

In `gateway/src/system-orchestrator/boot-reconciler.ts` add (alongside any existing exports):

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logging/logger";

const log = createLogger(["sentient", "boot-reconciler"]);

interface ProfileLike {
  readonly userId: string;
  readonly devices?: {
    signal?: { paired: boolean; account_masked?: string; linked_at?: string };
  };
}

export async function reconcileSignalPaired<T extends ProfileLike>(
  profile: T,
  profilesDir: string,
): Promise<T> {
  if (profile.devices?.signal?.paired !== true) return profile;

  const userDir = join(profilesDir, profile.userId);
  const signalDir = join(userDir, "signal-cli");
  const envPath = join(userDir, ".env");

  const dirOk = existsSync(signalDir);
  const envOk =
    existsSync(envPath) && readFileSync(envPath, "utf8").includes("SIGNAL_ACCOUNT=");

  if (dirOk && envOk) return profile;

  log.warn("signal-paired-inconsistent", {
    userId: profile.userId,
    signalDirPresent: dirOk,
    envHasAccount: envOk,
  });
  return {
    ...profile,
    devices: {
      ...profile.devices,
      signal: { ...profile.devices.signal, paired: false },
    },
  };
}
```

Hook `reconcileSignalPaired` into the existing boot reconcile loop so each profile passes through it before any supervisor-render step.

- [ ] **Step 5: Run tests**

```bash
cd gateway && bun run test src/system-orchestrator/boot-reconciler.test.ts
```

Expected: 3 new tests pass + existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/system-orchestrator/boot-reconciler.ts gateway/src/system-orchestrator/boot-reconciler.test.ts
git commit -m "feat(boot-reconciler): clear signal.paired on inconsistency between flag/dir/env"
```

---

### Task 14: Tinyproxy timeout — set to 0 for long-lived Signal WS

**Files:**
- Modify: `gateway/templates/services/egress-proxy/tinyproxy.conf`

Addresses Open Item #1 from the spec. Current `Timeout 600` kills Signal's WebSocket every 10 min, triggering reconnect storms.

- [ ] **Step 1: Read current tinyproxy config**

```bash
grep -nE "^[#\s]*Timeout|^[#\s]*KeepAlive|^[#\s]*MaxConnections" gateway/templates/services/egress-proxy/tinyproxy.conf
```

- [ ] **Step 2: Edit Timeout**

Open `gateway/templates/services/egress-proxy/tinyproxy.conf`, find `Timeout 600`, replace with:

```
# 0 = no idle timeout. Required so long-lived TLS tunnels (Signal's
# WebSocket to chat.signal.org, which the in-container signal-cli daemon
# proxies through here) aren't killed every 10 minutes.
Timeout 0
```

- [ ] **Step 3: Verify no other idle-kill setting interferes**

Confirm no `KeepAlive 0` line — `KeepAlive 1` is needed for CONNECT tunnel reuse.

- [ ] **Step 4: Commit**

```bash
git add gateway/templates/services/egress-proxy/tinyproxy.conf
git commit -m "fix(egress-proxy): Timeout 0 to keep long-lived Signal WebSocket alive"
```

---

### Task 15: API handler — link + cancel + status + unlink + list

**Files:**
- Create: `gateway/src/api/handlers/devices.ts`

- [ ] **Step 1: Inspect existing handler patterns**

```bash
sed -n '1,80p' gateway/src/api/handlers/profile.ts
```

Note auth wrapper, Response.json shape, error envelope conventions.

- [ ] **Step 2: Implement handlers**

Create `gateway/src/api/handlers/devices.ts`:

```ts
import { PairingCoordinator } from "../../devices/signal/pairing-coordinator";
import { PendingLinks } from "../../devices/signal/pending-links";
import { SignalCliClient } from "../../devices/signal/signal-cli-client";
import { deriveSignalCliPort } from "../../devices/signal/port-allocator";
import { createLogger } from "../../logging/logger";

const log = createLogger(["sentient", "api", "devices"]);

// In-memory per-user coordinator + pending-links registry. Single process,
// per-user mutex pattern mirrors the existing apply-mutex in profile.ts.
const coordinators = new Map<string, PairingCoordinator>();
const pending = new PendingLinks();

export interface DevicesHandlerDeps {
  readonly getUserProfile: (userId: string) => Promise<unknown>;
  readonly getAcpPort: (userId: string) => Promise<number>;
  readonly provisionSignalCli: (userId: string) => Promise<void>;
  readonly waitForSignalCliHealth: (userId: string) => Promise<void>;
  readonly finalizePair: (userId: string, account: string) => Promise<void>;
  readonly cleanupOnFail: (userId: string) => Promise<void>;
  readonly unpair: (userId: string) => Promise<void>;
}

async function buildClientFor(
  userId: string,
  deps: DevicesHandlerDeps,
): Promise<SignalCliClient> {
  const acpPort = await deps.getAcpPort(userId);
  const port = deriveSignalCliPort(acpPort);
  return new SignalCliClient(`http://127.0.0.1:${port}`);
}

async function getOrCreateCoordinator(
  userId: string,
  deps: DevicesHandlerDeps,
): Promise<PairingCoordinator> {
  let c = coordinators.get(userId);
  if (!c) {
    const client = await buildClientFor(userId, deps);
    c = new PairingCoordinator(userId, {
      provisionSignalCli: () => deps.provisionSignalCli(userId),
      waitForHealth: () => deps.waitForSignalCliHealth(userId),
      finalizePair: (account: string) => deps.finalizePair(userId, account),
      cleanupOnFail: () => deps.cleanupOnFail(userId),
      client,
      now: () => Date.now(),
    });
    coordinators.set(userId, c);
  }
  return c;
}

export async function handleLinkSignal(
  userId: string,
  deps: DevicesHandlerDeps,
): Promise<Response> {
  const coord = await getOrCreateCoordinator(userId, deps);
  try {
    await coord.startPair();
  } catch (err) {
    if (String(err).includes("in progress")) {
      return Response.json({ error: "link-in-progress" }, { status: 429 });
    }
    return Response.json({ error: String(err) }, { status: 500 });
  }
  const uri = coord.getUri();
  if (!uri) {
    return Response.json(
      { error: "link-uri-unavailable", state: coord.state },
      { status: 500 },
    );
  }
  pending.put({
    userId,
    uri,
    expiresAt: coord.expiresAt ?? Date.now() + 5 * 60 * 1000,
    nonce: crypto.randomUUID(),
  });
  return Response.json({ uri, expiresAt: coord.expiresAt });
}

export async function handleLinkSignalCancel(
  userId: string,
  _deps: DevicesHandlerDeps,
): Promise<Response> {
  const coord = coordinators.get(userId);
  if (coord) await coord.cancel();
  pending.clear(userId);
  return Response.json({ ok: true });
}

export async function handleLinkSignalStatus(
  userId: string,
  deps: DevicesHandlerDeps,
): Promise<Response> {
  const coord = coordinators.get(userId);
  if (!coord) {
    const profile = (await deps.getUserProfile(userId)) as {
      devices?: { signal?: { paired: boolean; account_masked?: string } };
    };
    if (profile.devices?.signal?.paired) {
      return Response.json({
        state: "linked",
        account_masked: profile.devices.signal.account_masked,
      });
    }
    return Response.json({ state: "idle" });
  }
  return Response.json({
    state: coord.state,
    error: coord.error,
  });
}

export async function handleUnlinkSignal(
  userId: string,
  deps: DevicesHandlerDeps,
): Promise<Response> {
  try {
    await deps.unpair(userId);
    coordinators.delete(userId);
    pending.clear(userId);
    log.info("signal-unlinked", { userId });
    return Response.json({ status: "unlinked" });
  } catch (err) {
    log.warn("signal-unlink-failed", { userId, error: String(err) });
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function handleListDevices(
  userId: string,
  deps: DevicesHandlerDeps,
): Promise<Response> {
  const profile = (await deps.getUserProfile(userId)) as {
    devices?: {
      signal?: { paired: boolean; account_masked?: string; linked_at?: string };
    };
  };
  return Response.json({
    platforms: {
      signal: profile.devices?.signal ?? { paired: false },
    },
  });
}
```

- [ ] **Step 3: Typecheck**

```bash
source scripts/env.sh
bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/api/handlers/devices.ts
git commit -m "feat(api): devices handlers for /api/devices and /api/devices/signal/*"
```

---

### Task 16: Wire devices handlers into router

**Files:**
- Modify: `gateway/src/api/router.ts`

- [ ] **Step 1: Inspect router**

```bash
cat gateway/src/api/router.ts
```

Note auth-middleware shape, userId extraction from session, route-registration pattern.

- [ ] **Step 2: Wire device routes**

In `router.ts`, add (adapt to actual route-registration API):

```ts
import {
  handleLinkSignal,
  handleLinkSignalCancel,
  handleLinkSignalStatus,
  handleUnlinkSignal,
  handleListDevices,
  type DevicesHandlerDeps,
} from "./handlers/devices";

// `devicesDeps` is constructed in phase-services.ts and passed into the router
// factory. See Task 17.

router.add("POST", "/api/devices/signal/link", (req, ctx) =>
  handleLinkSignal(ctx.userId, devicesDeps),
);
router.add("POST", "/api/devices/signal/link/cancel", (req, ctx) =>
  handleLinkSignalCancel(ctx.userId, devicesDeps),
);
router.add("GET", "/api/devices/signal/link/status", (req, ctx) =>
  handleLinkSignalStatus(ctx.userId, devicesDeps),
);
router.add("POST", "/api/devices/signal/unlink", (req, ctx) =>
  handleUnlinkSignal(ctx.userId, devicesDeps),
);
router.add("GET", "/api/devices", (req, ctx) =>
  handleListDevices(ctx.userId, devicesDeps),
);
```

- [ ] **Step 3: Typecheck (expected to fail until Task 17 wires devicesDeps)**

```bash
source scripts/env.sh
bun run typecheck
```

Expected: failure mentioning `devicesDeps`. Note the failure; clears after Task 17.

- [ ] **Step 4: Commit (with known failing typecheck)**

```bash
git add gateway/src/api/router.ts
git commit -m "feat(api/router): wire /api/devices and /api/devices/signal/* routes"
```

---

### Task 17: signalProvisioner + bootstrap wiring

**Files:**
- Create: `gateway/src/devices/signal/signal-provisioner.ts`
- Modify: `gateway/src/bootstrap/phase-services.ts`

- [ ] **Step 1: Implement signalProvisioner**

Create `gateway/src/devices/signal/signal-provisioner.ts`:

```ts
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { SignalCliClient } from "./signal-cli-client";
import { deriveSignalCliPort } from "./port-allocator";
import { clearSignalEnv, mergeSignalEnv } from "../../profile-store/env-writer";
import { createLogger } from "../../logging/logger";

const log = createLogger(["sentient", "devices", "signal", "provisioner"]);

const PROVISION_HEALTH_TIMEOUT_MS = 30_000;
const PROVISION_HEALTH_POLL_MS = 1_000;

interface ProfileLike {
  userId: string;
  devices?: {
    signal?: { paired: boolean; account_masked?: string; linked_at?: string };
  };
}

export interface SignalProvisionerDeps {
  readonly getProfile: (userId: string) => Promise<ProfileLike>;
  readonly setProfile: (userId: string, profile: ProfileLike) => Promise<void>;
  readonly getAcpPort: (userId: string) => Promise<number>;
  readonly getHermesHome: (userId: string) => string;
  readonly renderAndWrite: (userId: string) => Promise<void>;
  readonly supervisorReread: () => Promise<void>;
  readonly supervisorRestart: (programs: string[]) => Promise<void>;
  readonly supervisorStopRemove: (programs: string[]) => Promise<void>;
}

function maskE164(num: string): string {
  const last4 = num.slice(-4);
  return `${num.slice(0, 2)}•••••${last4}`;
}

export class SignalProvisioner {
  constructor(private readonly deps: SignalProvisionerDeps) {}

  async provision(userId: string): Promise<void> {
    log.info("provision-start", { userId });
    const hermesHome = this.deps.getHermesHome(userId);
    const signalDir = join(hermesHome, "signal-cli");
    if (!existsSync(signalDir)) {
      mkdirSync(signalDir, { mode: 0o700, recursive: true });
    }
    // Render emits the signal-cli supervisor program. Gateway program is
    // held back until finalize() sets devices.signal.paired = true.
    await this.deps.renderAndWrite(userId);
    await this.deps.supervisorReread();
  }

  async waitForHealth(userId: string): Promise<void> {
    const acpPort = await this.deps.getAcpPort(userId);
    const port = deriveSignalCliPort(acpPort);
    const client = new SignalCliClient(`http://127.0.0.1:${port}`);
    const deadline = Date.now() + PROVISION_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await client.health()) return;
      await new Promise((r) => setTimeout(r, PROVISION_HEALTH_POLL_MS));
    }
    throw new Error(
      `signal-cli did not become healthy within ${PROVISION_HEALTH_TIMEOUT_MS}ms`,
    );
  }

  async finalize(userId: string, account: string): Promise<void> {
    log.info("finalize", { userId, account_masked: maskE164(account) });
    const acpPort = await this.deps.getAcpPort(userId);
    const hermesHome = this.deps.getHermesHome(userId);
    const port = deriveSignalCliPort(acpPort);
    await mergeSignalEnv(join(hermesHome, ".env"), {
      httpUrl: `http://127.0.0.1:${port}`,
      account,
      allowedUsers: account,
    });
    const profile = await this.deps.getProfile(userId);
    await this.deps.setProfile(userId, {
      ...profile,
      devices: {
        ...profile.devices,
        signal: {
          paired: true,
          account_masked: maskE164(account),
          linked_at: new Date().toISOString(),
        },
      },
    });
    // Re-render now that paired flag is true; supervisor reread picks up the
    // new gateway program block.
    await this.deps.renderAndWrite(userId);
    await this.deps.supervisorReread();
    await this.deps.supervisorRestart([`hermes-${userId}-gateway`]);
  }

  async cleanup(userId: string): Promise<void> {
    log.info("cleanup-on-fail", { userId });
    const profile = await this.deps.getProfile(userId);
    if (profile.devices?.signal?.paired) {
      await this.deps.setProfile(userId, {
        ...profile,
        devices: { ...profile.devices, signal: { paired: false } },
      });
    }
    const hermesHome = this.deps.getHermesHome(userId);
    await clearSignalEnv(join(hermesHome, ".env"));
    await this.deps.renderAndWrite(userId);
    await this.deps.supervisorReread();
    await this.deps.supervisorStopRemove([
      `hermes-${userId}-signal-cli`,
      `hermes-${userId}-gateway`,
    ]);
  }

  async unpair(userId: string): Promise<void> {
    log.info("unpair-start", { userId });
    const acpPort = await this.deps.getAcpPort(userId);
    const hermesHome = this.deps.getHermesHome(userId);
    const port = deriveSignalCliPort(acpPort);
    const profile = await this.deps.getProfile(userId);

    // Best-effort removeAccount. If signal-cli is unreachable, proceed with
    // local cleanup — user can revoke the linked device phone-side anyway.
    const client = new SignalCliClient(`http://127.0.0.1:${port}`);
    try {
      const accounts = await client.listAccounts();
      for (const acc of accounts) {
        await client.removeAccount(acc);
      }
    } catch (err) {
      log.warn("removeAccount-failed-continuing", {
        userId,
        error: String(err),
      });
    }

    await clearSignalEnv(join(hermesHome, ".env"));
    await this.deps.setProfile(userId, {
      ...profile,
      devices: { ...profile.devices, signal: { paired: false } },
    });
    await this.deps.renderAndWrite(userId);
    await this.deps.supervisorReread();
    await this.deps.supervisorStopRemove([
      `hermes-${userId}-signal-cli`,
      `hermes-${userId}-gateway`,
    ]);

    const signalDir = join(hermesHome, "signal-cli");
    if (existsSync(signalDir)) {
      rmSync(signalDir, { recursive: true, force: true });
    }
    log.info("unpair-complete", { userId });
  }
}
```

- [ ] **Step 2: Wire provisioner in phase-services.ts**

Open `gateway/src/bootstrap/phase-services.ts`. Find where existing service dependencies (profile store, supervisord control, port allocator) are constructed. Add:

```ts
import { SignalProvisioner } from "../devices/signal/signal-provisioner";
import type { DevicesHandlerDeps } from "../api/handlers/devices";

// Inside the function/closure that builds the router-level deps:
const signalProvisioner = new SignalProvisioner({
  getProfile: profileStore.getProfile,
  setProfile: profileStore.setProfile,
  getAcpPort: portAllocator.getAcpPort,
  getHermesHome: (userId) => profileStore.hermesHomeFor(userId),
  renderAndWrite: (userId) => applyDeps.renderAndWrite(userId, { writeSoul: false }),
  supervisorReread: supervisordControl.rereadUpdate,
  supervisorRestart: supervisordControl.restart,
  supervisorStopRemove: supervisordControl.stopRemove,
});

const devicesDeps: DevicesHandlerDeps = {
  getUserProfile: profileStore.getProfile,
  getAcpPort: portAllocator.getAcpPort,
  provisionSignalCli: signalProvisioner.provision.bind(signalProvisioner),
  waitForSignalCliHealth: signalProvisioner.waitForHealth.bind(signalProvisioner),
  finalizePair: signalProvisioner.finalize.bind(signalProvisioner),
  cleanupOnFail: signalProvisioner.cleanup.bind(signalProvisioner),
  unpair: signalProvisioner.unpair.bind(signalProvisioner),
};

// Pass devicesDeps into the router factory alongside other handler deps.
```

Adapt names to the actual local objects (e.g. `supervisorControl` vs `supervisordControl`, `profileStore.hermesHomeFor` vs whatever helper exists).

- [ ] **Step 3: Typecheck**

```bash
source scripts/env.sh
bun run typecheck
```

Expected: clean. Task 16's pending failure now clears.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/devices/signal/signal-provisioner.ts gateway/src/bootstrap/phase-services.ts
git commit -m "feat(devices/signal): provisioner + bootstrap wiring for /api/devices/signal/* path"
```

---

### Task 18: Add qrcode dep to webui

**Files:**
- Modify: `gateway/webui/package.json`

We use the matrix-API of the `qrcode` lib (NOT `qrcode-svg`) and render the QR via JSX SVG `<rect>` elements — no `dangerouslySetInnerHTML`, no XSS surface.

- [ ] **Step 1: Add dep**

```bash
cd gateway/webui && bun add qrcode
bun add -d @types/qrcode
```

- [ ] **Step 2: Smoke import**

```bash
cd gateway/webui && bun --eval 'import QR from "qrcode"; QR.create("test").then(q => console.log("modules:", q.modules.size))'
```

Expected: prints `modules: <some integer>` (the size of the QR matrix).

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/package.json gateway/webui/bun.lockb
git commit -m "chore(webui): add qrcode for Signal pairing QR rendering"
```

---

### Task 19: devices-pane.tsx — unpaired + linked states

**Files:**
- Create: `gateway/webui/src/components/settings/panes/devices-pane.tsx`
- Modify: `gateway/webui/src/components/settings/panes/panes.css`

No unit tests for webui components per testing rules. Visual smoke covers in Task 23.

- [ ] **Step 1: Reference an existing pane**

```bash
sed -n '1,60p' gateway/webui/src/components/settings/panes/tools-pane.tsx
```

Note conventions: imports, fetch wrapper, state shape, JSX class names.

- [ ] **Step 2: Implement devices-pane**

Create `gateway/webui/src/components/settings/panes/devices-pane.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { QrLinkModal } from "./qr-link-modal";

const log = createLogger(["webui", "settings", "devices"]);

interface SignalDeviceState {
  paired: boolean;
  account_masked?: string;
  linked_at?: string;
}

interface DevicesPayload {
  platforms: { signal: SignalDeviceState };
}

export function DevicesPane() {
  const [state, setState] = useState<SignalDeviceState | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const resp = await fetch("/api/devices", { credentials: "include" });
    if (!resp.ok) {
      log.warn("devices-fetch-failed", { status: resp.status });
      return;
    }
    const data = (await resp.json()) as DevicesPayload;
    setState(data.platforms.signal);
  }

  useEffect(() => { void refresh(); }, []);

  async function unlink() {
    setBusy(true);
    try {
      const resp = await fetch("/api/devices/signal/unlink", {
        method: "POST",
        credentials: "include",
      });
      if (!resp.ok) {
        log.warn("unlink-failed", { status: resp.status });
        return;
      }
      setShowUnlinkConfirm(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <div class="pane">Loading…</div>;

  return (
    <div class="pane devices-pane">
      <div class="device-row">
        <div class="device-row-header">
          <span class="device-emoji">📱</span>
          <span class="device-name">Signal</span>
          {state.paired && <span class="device-status linked">● Linked</span>}
        </div>

        {state.paired ? (
          <>
            <p class="device-account">Account: {state.account_masked}</p>
            {state.linked_at && (
              <p class="device-linked-at">
                Linked: {new Date(state.linked_at).toLocaleString()}
              </p>
            )}
            <div class="device-howto">
              <p>How to use:</p>
              <ol>
                <li>Open Signal on your phone</li>
                <li>Go to "Note to Self" thread</li>
                <li>Text the agent like any chat</li>
              </ol>
            </div>
            <button
              class="btn btn-destructive"
              onClick={() => setShowUnlinkConfirm(true)}
              disabled={busy}
            >
              Unlink
            </button>
          </>
        ) : (
          <>
            <p class="device-desc">
              Text-chat with your agent from Signal. Uses "Note to Self" mode —
              links your own Signal account, no second number.
            </p>
            <button
              class="btn btn-primary"
              onClick={() => setShowQr(true)}
              disabled={busy}
            >
              Link Signal
            </button>
          </>
        )}
      </div>

      {showQr && (
        <QrLinkModal
          onClose={() => setShowQr(false)}
          onLinked={() => { setShowQr(false); void refresh(); }}
        />
      )}

      {showUnlinkConfirm && (
        <div class="modal-backdrop">
          <div class="modal">
            <h3>Disconnect Signal?</h3>
            <p>
              This removes Sentient as a linked device from your Signal account.
              Past Signal conversation history will be kept in your Sentient memory.
            </p>
            <div class="modal-actions">
              <button
                class="btn"
                onClick={() => setShowUnlinkConfirm(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                class="btn btn-destructive"
                onClick={unlink}
                disabled={busy}
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add CSS**

In `gateway/webui/src/components/settings/panes/panes.css`, append:

```css
.devices-pane .device-row {
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 8px;
  padding: 16px;
  background: var(--card-bg, #181818);
}
.devices-pane .device-row-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  margin-bottom: 8px;
}
.devices-pane .device-emoji { font-size: 20px; }
.devices-pane .device-name { font-weight: 600; }
.devices-pane .device-status.linked { color: #4caf50; margin-left: auto; font-size: 14px; }
.devices-pane .device-account,
.devices-pane .device-linked-at,
.devices-pane .device-desc {
  font-size: 14px;
  color: var(--text-secondary, #b0b0b0);
  margin: 6px 0;
}
.devices-pane .device-howto { font-size: 14px; margin: 10px 0; }
.devices-pane .device-howto ol { margin: 4px 0 0 18px; padding: 0; }
.devices-pane .btn-primary {
  background: var(--accent, #3b82f6);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
}
.devices-pane .btn-destructive {
  background: var(--danger, #b00020);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
}
```

Adjust CSS variables to match existing theme conventions (look at `tools-pane.tsx` styles for variable names actually in use).

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/settings/panes/devices-pane.tsx gateway/webui/src/components/settings/panes/panes.css
git commit -m "feat(webui): devices pane with linked/unpaired states + unlink confirm"
```

---

### Task 20: qr-link-modal.tsx (JSX-rendered SVG, no innerHTML)

**Files:**
- Create: `gateway/webui/src/components/settings/panes/qr-link-modal.tsx`
- Modify: `gateway/webui/src/components/settings/panes/panes.css`

The QR is rendered as `<rect>` elements inside an `<svg>` — no `dangerouslySetInnerHTML`, so no XSS surface even if the linking URI somehow contained hostile bytes.

- [ ] **Step 1: Implement modal**

Create `gateway/webui/src/components/settings/panes/qr-link-modal.tsx`:

```tsx
import { useEffect, useState } from "preact/hooks";
import QR from "qrcode";
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["webui", "settings", "devices", "qr-modal"]);

interface LinkInitResp {
  uri?: string;
  expiresAt?: number;
  error?: string;
}

interface LinkStatusResp {
  state:
    | "idle"
    | "provisioning"
    | "linking"
    | "awaitingScan"
    | "finalizing"
    | "linked"
    | "failed";
  account_masked?: string;
  error?: string;
}

interface Props {
  onClose: () => void;
  onLinked: () => void;
}

const STATUS_POLL_MS = 2000;

/**
 * Build a boolean matrix from the URI using the qrcode lib's matrix API.
 * Returns `[]` if input is empty.
 */
async function buildMatrix(uri: string): Promise<boolean[][]> {
  const qr = await QR.create(uri, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const m: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      // qr.modules.get returns 0 or 1
      row.push(qr.modules.get(y, x) === 1);
    }
    m.push(row);
  }
  return m;
}

export function QrLinkModal({ onClose, onLinked }: Props) {
  const [uri, setUri] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<boolean[][] | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<string>("");

  // Initiate the link request once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resp = await fetch("/api/devices/signal/link", {
        method: "POST",
        credentials: "include",
      });
      const data = (await resp.json()) as LinkInitResp;
      if (cancelled) return;
      if (!resp.ok) {
        setError(data.error ?? `HTTP ${resp.status}`);
        return;
      }
      setUri(data.uri ?? null);
      setExpiresAt(data.expiresAt ?? null);
    })();
    return () => { cancelled = true; };
  }, []);

  // Build matrix once URI lands.
  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    void buildMatrix(uri).then((m) => {
      if (!cancelled) setMatrix(m);
    });
    return () => { cancelled = true; };
  }, [uri]);

  // Poll status until linked or failed.
  useEffect(() => {
    if (!uri) return;
    const handle = setInterval(async () => {
      const resp = await fetch("/api/devices/signal/link/status", {
        credentials: "include",
      });
      const data = (await resp.json()) as LinkStatusResp;
      if (data.state === "linked") {
        clearInterval(handle);
        onLinked();
      } else if (data.state === "failed") {
        clearInterval(handle);
        setError(data.error ?? "Linking failed");
      }
    }, STATUS_POLL_MS);
    return () => clearInterval(handle);
  }, [uri]);

  // Countdown ticker.
  useEffect(() => {
    if (!expiresAt) return;
    const handle = setInterval(() => {
      const ms = expiresAt - Date.now();
      if (ms <= 0) {
        setRemaining("expired");
        return;
      }
      const mins = Math.floor(ms / 60_000);
      const secs = Math.floor((ms % 60_000) / 1000);
      setRemaining(`${mins}:${secs.toString().padStart(2, "0")}`);
    }, 500);
    return () => clearInterval(handle);
  }, [expiresAt]);

  async function cancel() {
    try {
      await fetch("/api/devices/signal/link/cancel", {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      log.warn("cancel-failed", { error: String(err) });
    }
    onClose();
  }

  return (
    <div class="modal-backdrop">
      <div class="modal qr-modal">
        <h3>Link your Signal account</h3>
        <ol class="qr-steps">
          <li>On your phone, open Signal</li>
          <li>Tap your avatar → Linked Devices</li>
          <li>Tap "Link New Device"</li>
          <li>Scan this QR code</li>
        </ol>
        {error ? (
          <p class="qr-error">{error}</p>
        ) : matrix ? (
          <svg
            class="qr-canvas"
            width="240"
            height="240"
            viewBox={`0 0 ${matrix.length} ${matrix.length}`}
            shape-rendering="crispEdges"
          >
            <rect width={matrix.length} height={matrix.length} fill="#ffffff" />
            {matrix.map((row, y) =>
              row.map((on, x) =>
                on ? (
                  <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000000" />
                ) : null,
              ),
            )}
          </svg>
        ) : (
          <p>Preparing link…</p>
        )}
        {!error && matrix && <p class="qr-countdown">Code expires in {remaining}</p>}
        <div class="modal-actions">
          <button class="btn" onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add CSS**

In `gateway/webui/src/components/settings/panes/panes.css`, append:

```css
.qr-modal { max-width: 360px; }
.qr-modal .qr-steps {
  font-size: 14px;
  color: var(--text-secondary, #b0b0b0);
  margin: 12px 0;
  padding-left: 20px;
}
.qr-modal .qr-canvas {
  display: block;
  margin: 12px auto;
  background: #fff;
  padding: 8px;
  border-radius: 6px;
  width: 240px;
  height: 240px;
}
.qr-modal .qr-countdown {
  font-size: 13px;
  color: var(--text-secondary, #b0b0b0);
  text-align: center;
  margin: 8px 0;
}
.qr-modal .qr-error {
  color: var(--danger, #b00020);
  font-size: 14px;
  margin: 12px 0;
}
```

- [ ] **Step 3: Typecheck**

```bash
source scripts/env.sh
bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/settings/panes/qr-link-modal.tsx gateway/webui/src/components/settings/panes/panes.css
git commit -m "feat(webui): QR linking modal — JSX-rendered SVG rects (no innerHTML)"
```

---

### Task 21: Wire Devices tab into Settings

**Files:**
- Modify: `gateway/webui/src/components/settings/settings.tsx`

- [ ] **Step 1: Locate tab list**

```bash
grep -n "Members\|Advanced\|TabKey\|tabs:" gateway/webui/src/components/settings/settings.tsx | head -20
```

- [ ] **Step 2: Add Devices tab between Members and Advanced**

Add to the tab enum/list and to the rendering switch:

```tsx
import { DevicesPane } from "./panes/devices-pane";

// in the tab list, between Members and Advanced:
{ key: "devices", label: "Devices" },

// in the switch:
case "devices": return <DevicesPane />;
```

Adapt to actual local syntax (it may be an object map rather than a switch).

- [ ] **Step 3: Typecheck**

```bash
source scripts/env.sh
bun run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/settings/settings.tsx
git commit -m "feat(webui/settings): add Devices tab between Members and Advanced"
```

---

### Task 22: Run full local CI

- [ ] **Step 1: Run lint**

```bash
source scripts/env.sh
bun run lint
```

Expected: clean. Fix any biome warnings inline.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Run all unit tests**

```bash
bun run test:unit
```

Expected: all green. New tests from Tasks 5, 7, 8, 13 all pass; renderer tests from Tasks 10, 11 pass; existing tests untouched.

- [ ] **Step 4: Commit fixup (only if needed)**

If steps 1–3 surfaced issues requiring edits to the new files:

```bash
git add -A
git commit -m "fixup: lint/typecheck/test cleanup for signal device pairing"
```

Otherwise skip.

---

### Task 23: Playwright MCP smoke matrix

Per `.claude/rules/e2e-testing.md`. Drive Playwright MCP against the local Docker stack. Real QR-scan completion is operator-only; ALL non-scan visual + API contract checks below must be green before pre-handover.

- [ ] **Step 1: Boot local stack**

```bash
source scripts/env.sh
cd deploy/macos
docker compose down
docker compose build gateway hermes
docker compose up -d
```

Wait for `sentient-gateway` and `sentient-hermes` both `(healthy)`.

- [ ] **Step 2: Log into webui via Playwright MCP**

`browser_navigate` to `https://localhost:8888`. Sign in with the local Kevin PIN `1234`.

- [ ] **Step 3: Smoke case 1 — Devices tab unpaired (desktop)**

- `browser_resize` 1280×900
- Navigate to Settings → click Devices tab
- `browser_snapshot` — verify Signal row + "Link Signal" button + description text
- `browser_take_screenshot` → `.playwright-mcp/devices-tab/devices-unpaired-desktop.png`
- `browser_console_messages` — assert no unexpected WARN/ERROR

- [ ] **Step 4: Smoke case 2 — Devices tab unpaired (mobile)**

- `browser_resize` 390×844
- Re-snapshot Devices tab
- `browser_take_screenshot` → `.playwright-mcp/devices-tab/devices-unpaired-mobile.png`

- [ ] **Step 5: Smoke case 3 — QR modal opens**

- `browser_resize` 1280×900
- `browser_click` on "Link Signal" button
- `browser_wait_for` selector `.qr-modal`
- `browser_snapshot` — verify QR `<svg>` element present, instruction list, countdown text
- `browser_evaluate` `(() => document.querySelectorAll('.qr-canvas rect').length)` — assert > 50 (QR matrix has many rects)
- `browser_take_screenshot` → `.playwright-mcp/devices-tab/qr-modal-desktop.png`
- Snapshot countdown text once at T0 and again 3s later; assert remaining-seconds decreased

- [ ] **Step 6: Smoke case 4 — QR modal mobile**

- `browser_resize` 390×844
- Snapshot + screenshot → `.playwright-mcp/devices-tab/qr-modal-mobile.png`

- [ ] **Step 7: Smoke case 5 — QR modal cancel**

- `browser_resize` 1280×900
- `browser_click` Cancel button
- `browser_wait_for` modal gone
- `browser_network_requests` — assert `/api/devices/signal/link/cancel` POST returned 200
- Wait 4s, then `browser_network_requests` again — assert no further `/api/devices/signal/link/status` polls fired

- [ ] **Step 8: Smoke case 6 — Linked state via mock fixture**

Inject mock paired state. The simplest path: use the gateway admin endpoint to set profile devices (if such an admin handler exists), OR shell into the host and edit the profile yaml + reapply:

```bash
# Direct profile yaml mutation (adjust path to your local userId):
USER=u_8c866990   # the local Kevin profile id
PROFILE=~/.sentient/gateway/data/$USER/profile.yaml
# Use yq or hand-edit to set:
#   devices:
#     signal:
#       paired: true
#       account_masked: "+1•••••1234"
#       linked_at: "2026-05-10T20:00:00Z"
# Then trigger apply via the webui Apply bar OR call the apply API.
```

Reload Settings → Devices tab.

- `browser_snapshot` — verify "● Linked", masked account, linked-at timestamp, How-to-use list, red Unlink button
- `browser_evaluate` `(() => /\+\d{10,15}/.test(document.body.innerText))` — assert `false` (no raw E.164 leaked)
- `browser_take_screenshot` → `.playwright-mcp/devices-tab/devices-linked-desktop.png`
- Repeat at 390×844 → `.playwright-mcp/devices-tab/devices-linked-mobile.png`

- [ ] **Step 9: Smoke case 7 — Unlink dialog cancel**

- `browser_click` Unlink → dialog opens
- `browser_snapshot` — verify destructive copy
- `browser_click` Cancel → dialog closes, still linked state

- [ ] **Step 10: Smoke case 8 — Unlink confirm**

- `browser_click` Unlink → click Disconnect
- `browser_wait_for` tab flips back to unpaired state
- `browser_network_requests` — assert `/api/devices/signal/unlink` POST returned 200
- `browser_take_screenshot` → `.playwright-mcp/devices-tab/devices-after-unlink.png`

- [ ] **Step 11: Smoke case 9 — Auth / sad paths**

Via `browser_evaluate`:

```js
await fetch("/api/devices/signal/link", { method: "POST" }).then(r => r.status)
```

Assert returns 401 / 403.

Double-click race: click "Link Signal" twice rapidly. Assert second click's network request returns 429 with body containing `link-in-progress`.

- [ ] **Step 12: Smoke case 10 — Re-pair after unlink**

After case 8, click "Link Signal" again. Verify QR modal opens cleanly, new URI generated, status polling starts. Cancel.

- [ ] **Step 13: Console hygiene final pass**

`browser_console_messages` across the whole run. Assert no unexpected WARN/ERROR beyond expected pair-lifecycle traces.

- [ ] **Step 14: Commit evidence**

If `.playwright-mcp/` is tracked:

```bash
git add .playwright-mcp/devices-tab/
git commit -m "test(smoke): devices tab — full Playwright matrix green except real QR scan (operator)"
```

If gitignored, just note the evidence path in handover (Task 24).

---

### Task 24: Local macOS stack smoke + handover

Gate before any Pi deploy, per `feedback_local_smoke_before_pi.md`.

- [ ] **Step 1: Verify local stack is freshly rebuilt**

Already done in Task 23 Step 1. If significant time elapsed, redo:

```bash
source scripts/env.sh
cd deploy/macos
docker compose down
docker compose build gateway hermes
docker compose up -d
```

Wait for both `(healthy)`.

- [ ] **Step 2: Edit SOUL via webui**

Log into webui. Settings → System Prompt → trivial edit. Apply. Confirm apply bar reaches `ready` without false "didn't come back, retry" (1.4.4 fix should still hold).

- [ ] **Step 3: Voice chat — "hi"**

Use voice toggle to chat "hi". Confirm agent responds. Verifies the renderer + orchestrator changes didn't regress voice path.

- [ ] **Step 4: Re-run Devices tab matrix on a fresh-paired-state local stack**

Repeat Task 23 cases on the rebuilt stack.

- [ ] **Step 5: Handover note**

In the PR description (or a sidecar markdown if PR doesn't exist yet), capture:

- Pre-handover gate status (all Playwright cases green, console clean, lint+typecheck+test green, local SOUL-edit + chat "hi" green)
- **Operator-only follow-up**: real QR-scan completion on Pi after deploy with operator's phone Signal app
- Tinyproxy `Timeout 0` rationale and operational implication (open connections accumulate; restart proxy weekly if a memory issue observed — none expected at family-user scale)
- Hermes overlay image size: ~7.76GB → ~8.0GB; first Pi build estimated +5-10 min; cached thereafter
- Per-paired-user RAM floor: +120-150MB JVM resident; 4-5 paired users on Pi 5 / 8GB is comfortable
- Signal account ban risk: documented in webui Devices tab help text; user accepts per stated preferences
- **Pi deploy is a SEPARATE explicit user approval** per `feedback_never_pi_without_approval.md` — DO NOT deploy without that approval

- [ ] **Step 6: Push branch**

```bash
git status
git push -u origin feature/signal-device-pairing
```

DO NOT merge to develop or main. DO NOT deploy to Pi. Both are explicit-approval gates.

---

## Spec Coverage Self-Review

| Spec section | Implemented by |
|---|---|
| §1 Goal + scope | Tasks 1, 17, 19, 21 |
| §1 Out-of-scope items | Not implemented (correctly) — no other adapters added |
| §2 Supervisor topology (4 programs per paired user) | Tasks 9, 10 |
| §2 Port allocation | Task 4 |
| §2 Per-user data layout (signal-cli/ dir) | Task 17 (provisioner.provision) |
| §2 Network attachment + JVM proxy | Task 2 (JAVA_TOOL_OPTIONS in Dockerfile) |
| §2 Tinyproxy Timeout 0 | Task 14 |
| §2 Lifecycle (provision → link → finalize → unpair) | Tasks 8, 17 |
| §3 Pair sequence | Tasks 15, 17 |
| §3 Failure modes | Task 8 |
| §3 Unpair sequence | Task 17 |
| §3 Concurrency (per-user mutex) | Task 8 |
| §4 Devices tab layout | Tasks 19, 21 |
| §4 QR modal | Task 20 |
| §4 Unlink confirm | Task 19 |
| §5 Profile schema | Task 3 |
| §5 .env additions | Task 5 |
| §5 Hermes config.yaml additions | Task 11 |
| §5 Port allocator extension | Task 4 |
| §5 Single source of truth (profile.devices.signal.paired) | Tasks 10, 11, 12, 13 |
| §6 Dockerfile additions | Task 2 |
| §6 Supervisor program templates | Task 9 |
| §7 New `gateway/src/devices/signal/` modules | Tasks 4, 6, 7, 8, 17 |
| §7 API endpoints | Tasks 15, 16 |
| §7 Renderer extensions | Tasks 10, 11 |
| §7 .env writer module | Task 5 |
| §7 Apply orchestrator | Task 12 |
| §7 Boot reconciler | Task 13 |
| §7 Tests (signal-cli-client, pairing-coordinator, env-writer, boot-reconciler) | Tasks 5, 7, 8, 13 |
| §7 E2E smoke | Task 23 |
| §8 Security mitigations | Tasks 9, 14, 17, 19 (loopback bind, atomic env, masked PII, dir 0700, JSX-rendered QR no innerHTML, destructive-confirm dialog) |
| §8 Cron default delivery | Task 11 |
| §8 Open items resolved | Task 14 (tinyproxy); Task 2 (signal-cli pin, JVM proxy). Method-name verification flagged in Task 7. Image rebuild time noted in Task 24 handover. |
| §8 Backwards compat | Implicit — unpaired profiles unaffected (Tasks 10, 11 guard on flag) |
| §8 Rollback safety | Implicit — supervisor render is purely additive; signal-cli/ dir preserved |

No spec requirement is uncovered.

## Final Notes for the Engineer

- **DO NOT deploy to the Pi from this plan.** Pi deploy is a separate explicit-approval gate per `feedback_never_pi_without_approval.md`. After branch pushed + PR opened, wait for explicit user approval before any `ssh kevinye@hacore.lan` + `docker compose build/up`.
- **DO NOT skip Task 24's local stack smoke.** Mandatory before any Pi deploy.
- **DO NOT touch tuned constants** (VAD thresholds, audio timing) per `feedback_tuned_constants.md`. The only tunable touched here is the tinyproxy Timeout (operational, not tuned).
- **signal-cli JSON-RPC method names** in Task 7 are pinned against v0.13.x reference. If upstream uses different names (e.g. `link` instead of `startLink`, different param shape), adjust client + tests together and note in commit.
- **Per-user apply mutex** already exists from 1.4.3 work. Pair flow uses it implicitly via the `renderAndWrite` → supervisorctl path; no new mutex needed.
- **Logging**: all new modules use the existing tagged logger. Tags: `["sentient", "devices", "signal", ...]` for gateway-side, `["webui", "settings", "devices", ...]` for client. INFO lifecycle, WARN fallback/failure, DEBUG poll noise.
- **No magic numbers**: TTLs in the coordinator are file-level constants. If the user later wants them tunable, move to `gateway/config.yaml` per `.claude/rules/config.md`.
- **Security: no `dangerouslySetInnerHTML`**. The QR is rendered as JSX `<rect>` elements inside a `<svg>`. The `qrcode` lib gives us a boolean module matrix; we render it directly. Even if a hostile linking URI slipped through, no script could execute via this path.
