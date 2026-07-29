import { expect, test } from "bun:test";
import { reconcileOnBoot } from "./boot-reconciler.js";
import type { ManagedProcessInfo, ManagedService, OrchestratorStatus, ServiceDriver } from "./types.js";

const ok = { ok: true, value: undefined } as const;

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
  await reconcileOnBoot({ driver, registry: reg, orchestrator: orch });
  expect(removeCalls.some((s) => s.includes("fake-service") || s === "2")).toBe(true);
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
  await reconcileOnBoot({ driver, registry: reg, orchestrator: orch });
  expect(applyCount).toBe(1);
});
