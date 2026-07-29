import { expect, test } from "bun:test";
import { reconcileOnBoot } from "./boot-reconciler.js";
import type { LaunchKind, ManagedProcessInfo, ManagedService, OrchestratorStatus, ServiceDriver } from "./types.js";

const ok = { ok: true, value: undefined } as const;

/** Both backends resolve to the same stub — these tests exercise the reap
 *  decision, not the dispatch table. */
function allBackends(driver: ServiceDriver): Record<LaunchKind, ServiceDriver> {
  return { docker: driver, native: driver };
}

const ms = (name: string): ManagedService => ({
  name,
  config: {
    launch: "docker",
    template: "x",
    allowed_images: ["x"],
    networks: ["sentient-internal"],
    secrets: {},
    healthcheck: { url: "http://x/health", timeout_ms: 1000 },
    depends_on: [],
    optional: false,
  },
  template: {
    image: "x",
    container_name: `sentient-${name}`,
    networks: ["sentient-internal"],
    env: {},
    volumes: [],
    extra_hosts: [],
    group_add: [],
  },
});

test("orphan containers (managed but not in registry) are removed", async () => {
  const removeCalls: string[] = [];
  const driver: ServiceDriver = {
    prepare: async () => ok,
    recreate: async () => ok,
    start: async () => ok,
    stop: async () => ok,
    remove: async (name) => {
      removeCalls.push(name);
      return ok;
    },
    listManaged: async (): Promise<ManagedProcessInfo[]> => [
      { id: "1", service: "ha-mcp", state: "running" },
      { id: "2", service: "fake-service", state: "running" },
    ],
  };
  const reg = new Map([["ha-mcp", ms("ha-mcp")]]);
  const orch = {
    applyAll: async (): Promise<OrchestratorStatus> => ({
      state: "ready",
      services: [],
      startedAt: 0,
      finishedAt: 1,
    }),
  };
  await reconcileOnBoot({ drivers: allBackends(driver), registry: reg, orchestrator: orch });
  expect(removeCalls.some((s) => s.includes("fake-service") || s === "2")).toBe(true);
});

test("CONTRACT: each backend's orphans are reaped through that backend's OWN driver", async () => {
  // The one test that gives the two backends different stubs. With a single
  // shared stub, a reconciler that visited only one launch kind — or routed
  // both through one driver — would look identical: the same orphan list would
  // come back and the same remove() would fire twice.
  const dockerRemoved: string[] = [];
  const nativeRemoved: string[] = [];
  const backend = (orphan: string, into: string[]): ServiceDriver => ({
    prepare: async () => ok,
    recreate: async () => ok,
    start: async () => ok,
    stop: async () => ok,
    remove: async (id) => {
      into.push(id);
      return ok;
    },
    listManaged: async (): Promise<ManagedProcessInfo[]> => [{ id: orphan, service: orphan, state: "running" }],
  });
  const reg = new Map([["ha-mcp", ms("ha-mcp")]]);
  const orch = {
    applyAll: async (): Promise<OrchestratorStatus> => ({
      state: "ready",
      services: [],
      startedAt: 0,
      finishedAt: 1,
    }),
  };

  await reconcileOnBoot({
    drivers: {
      docker: backend("stale-container", dockerRemoved),
      native: backend("stale-process", nativeRemoved),
    },
    registry: reg,
    orchestrator: orch,
  });

  expect(dockerRemoved).toEqual(["stale-container"]);
  expect(nativeRemoved).toEqual(["stale-process"]);
});

test("calls applyAll after orphan reap to bring up registry services", async () => {
  let applyCount = 0;
  const driver: ServiceDriver = {
    prepare: async () => ok,
    recreate: async () => ok,
    start: async () => ok,
    stop: async () => ok,
    remove: async () => ok,
    listManaged: async () => [],
  };
  const reg = new Map([["ha-mcp", ms("ha-mcp")]]);
  const orch = {
    applyAll: async (): Promise<OrchestratorStatus> => {
      applyCount++;
      return { state: "ready", services: [], startedAt: 0, finishedAt: 1 };
    },
  };
  await reconcileOnBoot({ drivers: allBackends(driver), registry: reg, orchestrator: orch });
  expect(applyCount).toBe(1);
});
