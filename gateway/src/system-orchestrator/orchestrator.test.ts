import { expect, test } from "bun:test";
import type { HealthIO } from "./health.js";
import { createSystemOrchestrator } from "./orchestrator.js";
import type { LaunchKind, ManagedService, ServiceDriver } from "./types.js";

const ok = { ok: true, value: undefined } as const;
function svc(name: string, deps: string[] = [], optional = false): ManagedService {
  return {
    name,
    config: {
      launch: "docker",
      template: "x",
      allowed_images: ["x"],
      networks: ["sentient-internal"],
      secrets: {},
      healthcheck: { url: `http://${name}/health`, timeout_ms: 200 },
      depends_on: deps,
      optional,
    },
    template: {
      image: "x",
      container_name: name,
      networks: ["sentient-internal"],
      env: {},
      volumes: [],
      extra_hosts: [],
      group_add: [],
    },
  };
}

const happyDriver: ServiceDriver = {
  prepare: async () => ok,
  recreate: async () => ok,
  start: async () => ok,
  stop: async () => ok,
  remove: async () => ok,
  listManaged: async () => [],
};

/** Both backends resolve to the same stub — these tests exercise the apply
 *  FSM, not the dispatch table. */
function allBackends(driver: ServiceDriver): Record<LaunchKind, ServiceDriver> {
  return { docker: driver, native: driver };
}

const healthyIO: HealthIO = {
  fetch: async () => ({ ok: true }),
  tcpProbe: async () => true,
  execProbe: async () => 0,
  sleep: async () => {},
  now: () => 0,
};

test("orchestrator brings all services to ready when everything is healthy", async () => {
  const reg = new Map([
    ["a", svc("a")],
    ["b", svc("b", ["a"])],
  ]);
  const orch = createSystemOrchestrator({
    registry: reg,
    drivers: allBackends(happyDriver),
    healthIO: healthyIO,
    pollIntervalMs: 1,
    applyTimeoutMs: 10000,
  });
  const r = await orch.applyAll();
  expect(r.state).toBe("ready");
  expect(r.services.find((s) => s.name === "a")?.state).toBe("ready");
});

test("optional service health failure leaves orchestrator ready, marks degraded", async () => {
  const reg = new Map([
    ["req", svc("req")],
    ["opt", svc("opt", [], true)],
  ]);
  const sometimesHealthy: HealthIO = {
    ...healthyIO,
    fetch: async (url) => ({ ok: !url.includes("opt") }),
    now: (() => {
      let t = 0;
      return () => {
        t = t + 100;
        return t;
      };
    })(),
  };
  const orch = createSystemOrchestrator({
    registry: reg,
    drivers: allBackends(happyDriver),
    healthIO: sometimesHealthy,
    pollIntervalMs: 1,
    applyTimeoutMs: 500,
  });
  const r = await orch.applyAll();
  expect(r.state).toBe("ready");
  expect(r.services.find((s) => s.name === "opt")?.state).toBe("degraded");
});

test("required service failure leaves orchestrator failed", async () => {
  const reg = new Map([["req", svc("req")]]);
  const failingDriver: ServiceDriver = {
    ...happyDriver,
    recreate: async () => ({ ok: false, error: { kind: "create-failed", reason: "boom" } }),
  };
  const orch = createSystemOrchestrator({
    registry: reg,
    drivers: allBackends(failingDriver),
    healthIO: healthyIO,
    pollIntervalMs: 1,
    applyTimeoutMs: 100,
  });
  const r = await orch.applyAll();
  expect(r.state).toBe("failed");
});

test("downstream of a failed required service is marked blocked-by-dep", async () => {
  const reg = new Map([
    ["a", svc("a")],
    ["b", svc("b", ["a"])],
  ]);
  const failOnA: ServiceDriver = {
    ...happyDriver,
    recreate: async (ms) => (ms.name === "a" ? { ok: false, error: { kind: "create-failed", reason: "x" } } : ok),
  };
  const orch = createSystemOrchestrator({
    registry: reg,
    drivers: allBackends(failOnA),
    healthIO: healthyIO,
    pollIntervalMs: 1,
    applyTimeoutMs: 100,
  });
  const r = await orch.applyAll();
  expect(r.services.find((s) => s.name === "b")?.state).toBe("blocked-by-dep");
});

test("applySubset only touches the requested services", async () => {
  const reg = new Map([
    ["a", svc("a")],
    ["b", svc("b")],
  ]);
  const seen: string[] = [];
  const tracking: ServiceDriver = {
    ...happyDriver,
    recreate: async (ms) => {
      seen.push(ms.name);
      return ok;
    },
  };
  const orch = createSystemOrchestrator({
    registry: reg,
    drivers: allBackends(tracking),
    healthIO: healthyIO,
    pollIntervalMs: 1,
    applyTimeoutMs: 100,
  });
  await orch.applySubset(new Set(["b"]));
  expect(seen).toEqual(["b"]);
});

test("getStatus reflects terminal state after applyAll resolves", async () => {
  const reg = new Map([["a", svc("a")]]);
  const orch = createSystemOrchestrator({
    registry: reg,
    drivers: allBackends(happyDriver),
    healthIO: healthyIO,
    pollIntervalMs: 1,
    applyTimeoutMs: 100,
  });
  await orch.applyAll();
  const s = orch.getStatus();
  expect(s.state).toBe("ready");
  expect(s.finishedAt).not.toBeNull();
});

test("concurrent applyAll calls share a single in-flight apply", async () => {
  const reg = new Map([["a", svc("a")]]);
  let recreates = 0;
  const counting: ServiceDriver = {
    ...happyDriver,
    recreate: async () => {
      recreates++;
      return ok;
    },
  };
  const orch = createSystemOrchestrator({
    registry: reg,
    drivers: allBackends(counting),
    healthIO: healthyIO,
    pollIntervalMs: 1,
    applyTimeoutMs: 100,
  });
  const [r1, r2] = await Promise.all([orch.applyAll(), orch.applyAll()]);
  expect(recreates).toBe(1);
  expect(r1).toBe(r2); // same status object — same in-flight promise
});

test("dep-graph cycle leaves every service with a lastError reason", async () => {
  const reg = new Map([
    ["a", svc("a", ["b"])],
    ["b", svc("b", ["a"])],
  ]);
  const orch = createSystemOrchestrator({
    registry: reg,
    drivers: allBackends(happyDriver),
    healthIO: healthyIO,
    pollIntervalMs: 1,
    applyTimeoutMs: 100,
  });
  const r = await orch.applyAll();
  expect(r.state).toBe("failed");
  for (const s of r.services) {
    expect(s.lastError).not.toBeNull();
    expect(s.lastError).toContain("dependency graph");
  }
});
