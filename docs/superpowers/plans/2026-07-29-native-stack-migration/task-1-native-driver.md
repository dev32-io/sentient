### Task 1: The `native` launch type in the system orchestrator

**Wave 1 · model: opus · spec §6**

The gateway stays containerised throughout this task. That is intended: the change is purely additive, so both drivers are exercised before the cutover (Task 4) depends on them.

**Files:**
- Modify: `gateway/src/system-orchestrator/types.ts`
- Modify: `gateway/src/system-orchestrator/docker-driver.ts` (rename `pullImage` → `prepare`)
- Modify: `gateway/src/system-orchestrator/orchestrator.ts` (call site of the rename)
- Modify: `gateway/src/system-orchestrator/index.ts` (driver wiring)
- Create: `gateway/src/system-orchestrator/native-driver.ts`
- Create: `gateway/src/system-orchestrator/native-driver.test.ts`
- Modify: `gateway/src/system-orchestrator/types.test.ts`
- Modify: `gateway/config.yaml` — **only** the two new `managed_services` entries. Task 4 owns this file next wave; broader edits will conflict.

**Interfaces:**

Consumes (existing, verified):
```ts
// types.ts
export const HealthCheckSchema: z.ZodUnion<...>   // url | tcp | exec | noop
export type ManagedService = { name: ServiceName; config: ManagedServiceConfig; template: ServiceTemplate }
// docker-driver.ts
export interface DockerDriver {
  recreate(ms: ManagedService): Promise<Result<undefined, DockerError>>;
  start(name: string): Promise<Result<undefined, DockerError>>;
  stop(name: string): Promise<Result<undefined, DockerError>>;
  remove(name: string): Promise<Result<undefined, DockerError>>;
  pullImage(image: string): Promise<Result<undefined, DockerError>>;   // → becomes prepare
  listManaged(): Promise<ManagedContainerInfo[]>;
}
```

Produces (later tasks rely on these exact names):
```ts
export type LaunchKind = "docker" | "native";
export interface ServiceDriver {
  prepare(ms: ManagedService): Promise<Result<undefined, DriverError>>;
  recreate(ms: ManagedService): Promise<Result<undefined, DriverError>>;
  start(name: string): Promise<Result<undefined, DriverError>>;
  stop(name: string): Promise<Result<undefined, DriverError>>;
  remove(name: string): Promise<Result<undefined, DriverError>>;
  listManaged(): Promise<ManagedProcessInfo[]>;
}
export function createNativeDriver(deps: NativeDriverDeps): ServiceDriver;
```

---

- [ ] **Step 1: Write the failing test for the `launch` discriminator defaulting to docker**

Every existing `managed_services` entry omits `launch`. They must keep parsing byte-identically, or the cutover breaks eight services at once.

In `gateway/src/system-orchestrator/types.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { ManagedServiceConfigSchema } from "./types.js";

describe("ManagedServiceConfigSchema — launch discriminator", () => {
  it("CONTRACT: an entry with no `launch` key parses as docker", () => {
    const parsed = ManagedServiceConfigSchema.parse({
      template: "ha-mcp.yaml",
      allowed_images: ["sentient/ha-mcp:local"],
      networks: ["sentient-internal"],
      healthcheck: { tcp: "127.0.0.1:8086", timeout_ms: 30000 },
    });
    expect(parsed.launch).toBe("docker");
  });

  it("CONTRACT: a native entry needs neither allowed_images nor networks", () => {
    const parsed = ManagedServiceConfigSchema.parse({
      launch: "native",
      exec: ["/opt/sentient/current/whisper-stt/venv/bin/python", "-m", "whisper_stt"],
      python: "3.14",
      healthcheck: { tcp: "127.0.0.1:8766", timeout_ms: 30000 },
    });
    expect(parsed.launch).toBe("native");
    if (parsed.launch !== "native") throw new Error("unreachable");
    expect(parsed.exec[0]).toContain("whisper-stt");
  });

  it("rejects a native entry with an empty exec argv", () => {
    const r = ManagedServiceConfigSchema.safeParse({
      launch: "native",
      exec: [],
      healthcheck: { noop: true },
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
cd gateway/src && bun test system-orchestrator/types.test.ts
```
Expected: FAIL — `expect(parsed.launch).toBe("docker")` gets `undefined`, because `ManagedServiceConfigSchema` has no `launch` field yet. The native case fails validation on the missing required `allowed_images`.

- [ ] **Step 3: Implement the discriminated union**

`z.discriminatedUnion` requires the discriminator to be present, so a bare `.default("docker")` on the literal does **not** cover an entry that omits the key. Inject it in a `preprocess` first:

In `gateway/src/system-orchestrator/types.ts`, replace `ManagedServiceConfigSchema`:

```ts
export const LaunchKindSchema = z.enum(["docker", "native"]);
export type LaunchKind = z.infer<typeof LaunchKindSchema>;

const CommonServiceFields = {
  healthcheck: HealthCheckSchema,
  depends_on: z.array(ServiceNameSchema).optional().default([]),
  optional: z.boolean().optional().default(false),
};

export const DockerServiceConfigSchema = z.object({
  launch: z.literal("docker"),
  template: z.string().min(1),
  allowed_images: z.array(z.string().min(1)).nonempty(),
  networks: z.array(z.string().min(1)).nonempty(),
  secrets: z.record(z.string(), z.string()).optional().default({}),
  ...CommonServiceFields,
});

export const NativeServiceConfigSchema = z.object({
  launch: z.literal("native"),
  /** argv; argv[0] is the interpreter or binary. Never shell-interpreted. */
  exec: z.array(z.string().min(1)).nonempty(),
  /** Pinned interpreter, e.g. "3.11". Verified by prepare() before start. */
  python: z.string().regex(/^\d+\.\d+$/).optional(),
  env: z.record(z.string(), z.string()).optional().default({}),
  cwd: z.string().optional(),
  ...CommonServiceFields,
});

/** `launch` defaults to "docker" so every pre-existing entry parses unchanged.
 *  A discriminated union cannot express that default on its own — the key must
 *  exist before discrimination, hence the preprocess. */
export const ManagedServiceConfigSchema = z.preprocess(
  (raw) =>
    typeof raw === "object" && raw !== null && !("launch" in raw) ? { ...raw, launch: "docker" } : raw,
  z.discriminatedUnion("launch", [DockerServiceConfigSchema, NativeServiceConfigSchema]),
);
export type ManagedServiceConfig = z.infer<typeof ManagedServiceConfigSchema>;
```

- [ ] **Step 4: Run to green**

```bash
cd gateway/src && bun test system-orchestrator/types.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Prove the real config still parses**

The unit test uses hand-built objects. The regression that matters is the **actual** `gateway/config.yaml`.

```bash
cd gateway/src && bun test system-orchestrator/
```
Expected: PASS — `service-registry.test.ts` and `template-loader.test.ts` unchanged and green. If any fail, the preprocess is wrong; fix it before continuing.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(orchestrator): add the launch discriminator to managed services" -- \
  gateway/src/system-orchestrator/types.ts gateway/src/system-orchestrator/types.test.ts
```

- [ ] **Step 7: Write the failing test for the orphan-reaping invariant**

This is the one genuinely dangerous behaviour in the native driver: a SIGKILLed gateway cannot run a shutdown hook, so children must be killable by a later boot. Spawning into its own process group is what makes that possible.

Create `gateway/src/system-orchestrator/native-driver.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { createNativeDriver } from "./native-driver.js";
import type { ManagedService } from "./types.js";

function nativeService(name: string, exec: string[]): ManagedService {
  return {
    name,
    config: {
      launch: "native",
      exec,
      env: {},
      healthcheck: { noop: true },
      depends_on: [],
      optional: false,
    },
    template: {} as ManagedService["template"],
  };
}

describe("native-driver", () => {
  it("INVARIANT: a started service is spawned into its OWN process group", async () => {
    const spawned: Array<{ cmd: string[]; opts: Record<string, unknown> }> = [];
    const driver = createNativeDriver({
      spawn: (cmd, opts) => {
        spawned.push({ cmd, opts });
        return { pid: 4242, exited: new Promise(() => {}), kill: () => {} };
      },
      writePidFile: async () => {},
      readPidFiles: async () => [],
      killPid: () => {},
    });

    await driver.start2(nativeService("whisper-stt", ["/bin/echo", "hi"]));

    expect(spawned).toHaveLength(1);
    // detached: true is what puts the child in its own group, so a later boot
    // can kill(-pgid) the whole tree even after the gateway was SIGKILLed.
    expect(spawned[0]?.opts.detached).toBe(true);
  });

  it("INVARIANT: reapOrphans kills PIDs left by a previous gateway process", async () => {
    const killed: number[] = [];
    const driver = createNativeDriver({
      spawn: () => ({ pid: 1, exited: new Promise(() => {}), kill: () => {} }),
      writePidFile: async () => {},
      readPidFiles: async () => [{ name: "local-tts", pid: 999 }],
      killPid: (pid) => killed.push(pid),
    });

    await driver.reapOrphans();

    expect(killed).toEqual([999]);
  });
});
```

- [ ] **Step 8: Run it and confirm it fails**

```bash
cd gateway/src && bun test system-orchestrator/native-driver.test.ts
```
Expected: FAIL — `Cannot find module './native-driver.js'`.

- [ ] **Step 9: Implement `native-driver.ts`**

```ts
// Native launch backend for the system orchestrator. Mirrors docker-driver's
// lifecycle so everything above the driver — dep-graph, health, boot-reconciler
// — stays backend-agnostic.
//
// PROCESS GROUPS: children are spawned detached, i.e. into their own process
// group, and their pids are written to disk. The gateway cannot run a shutdown
// hook when SIGKILLed, so without this a killed gateway would leave whisper-stt
// and local-tts running and the next boot would fail to bind their ports.
// reapOrphans() at boot closes that hole.
import { getLog } from "../logging/logger.js";
import type { ManagedService, ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "native-driver"]);

const SIGTERM_GRACE_MS = 5000;

export interface NativeProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: string): void;
}

export interface NativeDriverDeps {
  spawn(cmd: string[], opts: Record<string, unknown>): NativeProcess;
  writePidFile(name: ServiceName, pid: number): Promise<void>;
  readPidFiles(): Promise<Array<{ name: ServiceName; pid: number }>>;
  killPid(pid: number): void;
}

export function createNativeDriver(deps: NativeDriverDeps) {
  const running = new Map<ServiceName, NativeProcess>();

  async function start2(ms: ManagedService): Promise<void> {
    if (ms.config.launch !== "native") throw new Error(`not a native service: ${ms.name}`);
    const proc = deps.spawn([...ms.config.exec], {
      // Own process group — see the file header.
      detached: true,
      env: ms.config.env,
      cwd: ms.config.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    running.set(ms.name, proc);
    await deps.writePidFile(ms.name, proc.pid);
    log.info("native.started", { service: ms.name, pid: proc.pid });
  }

  async function reapOrphans(): Promise<void> {
    for (const { name, pid } of await deps.readPidFiles()) {
      log.warn("native.orphan-reaped", { service: name, pid, reason: "pid file survived a gateway restart" });
      deps.killPid(pid);
    }
  }

  return { start2, reapOrphans, running };
}
```

- [ ] **Step 10: Run to green**

```bash
cd gateway/src && bun test system-orchestrator/native-driver.test.ts
```
Expected: PASS, 2 tests.

- [ ] **Step 11: Commit**

```bash
git commit -m "feat(orchestrator): native driver with process-group isolation and orphan reaping" -- \
  gateway/src/system-orchestrator/native-driver.ts \
  gateway/src/system-orchestrator/native-driver.test.ts
```

- [ ] **Step 12: Rename `pullImage` → `prepare` across the interface and its callers**

`pullImage` is the only docker-specific member of the driver interface, and it has an exact native analogue: *ensure the artifact exists*. For docker that is pulling the image; for native it is verifying the venv and its pinned interpreter.

Find every call site first:
```bash
grep -rn "pullImage" gateway/src --include="*.ts"
```
Rename the method on `DockerDriver` in `docker-driver.ts`, its implementation, and each call site found above. The body is unchanged — this is a rename, not a behaviour change.

- [ ] **Step 13: Run the whole orchestrator suite**

```bash
cd gateway/src && bun test system-orchestrator/
```
Expected: PASS. A missed call site shows up as a typecheck error, not a test failure, so also run:
```bash
bun run --filter '@sentient/gateway' typecheck
```
Expected: exit 0.

- [ ] **Step 14: Commit**

```bash
git commit -m "refactor(orchestrator): rename pullImage to prepare for driver parity" -- \
  gateway/src/system-orchestrator/docker-driver.ts \
  gateway/src/system-orchestrator/docker-driver.test.ts \
  gateway/src/system-orchestrator/orchestrator.ts \
  gateway/src/system-orchestrator/index.ts
```

- [ ] **Step 15: Register whisper-stt and local-tts as native services**

In `gateway/config.yaml`, under `managed_services:`, add **only** these two entries. Do not touch anything else in this file.

```yaml
  whisper-stt:
    launch: native
    # argv[0] is the pinned interpreter; ${SENTIENT_CODE} resolves to the
    # root-owned release dir (/opt/sentient/current) in prod, or the repo
    # checkout in dev.
    exec: ["${SENTIENT_CODE}/whisper-stt/venv/bin/python", "-m", "whisper_stt"]
    python: "3.14"                                  # pinned; prepare() verifies before start
    healthcheck: { tcp: "127.0.0.1:8766", timeout_ms: 30000 }   # STT WS port
    depends_on: []
    optional: false

  local-tts:
    launch: native
    exec: ["${SENTIENT_CODE}/local-tts/venv/bin/python", "-m", "local_tts"]
    python: "3.11"                                  # 3.11 REQUIRED: mlx-audio ships no 3.14 wheels
    healthcheck: { tcp: "127.0.0.1:8770", timeout_ms: 30000 }   # TTS WS port
    depends_on: []
    optional: false
```

- [ ] **Step 16: Verify the real config parses with both launch kinds**

```bash
cd gateway/src && bun test system-orchestrator/
bun run --filter '@sentient/gateway' typecheck
```
Expected: both green. The registry now contains ten services across two launch kinds.

- [ ] **Step 17: Commit**

```bash
git commit -m "feat(config): register whisper-stt and local-tts as native services" -- gateway/config.yaml
```
