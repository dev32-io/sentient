import { expect, test } from "bun:test";
import { type DockerodeLike, createDockerDriver } from "./docker-driver.js";
import type { DockerManagedService } from "./types.js";

const ms: DockerManagedService = {
  name: "ha-mcp",
  config: {
    launch: "docker",
    template: "x",
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"],
    networks: ["sentient-internal"],
    secrets: {},
    healthcheck: { url: "http://ha-mcp:8086/health", timeout_ms: 1000 },
    depends_on: [],
    optional: true,
  },
  template: {
    image: "ghcr.io/homeassistant-ai/ha-mcp:stable",
    container_name: "sentient-ha-mcp",
    networks: ["sentient-internal"],
    env: { HOMEASSISTANT_TOKEN: "tok" },
    volumes: [],
    ports: [],
    extra_hosts: [],
    group_add: [],
  },
};

function makeStub(): { stub: DockerodeLike; calls: { create: unknown[]; remove: unknown[]; start: unknown[] } } {
  const calls = { create: [] as unknown[], remove: [] as unknown[], start: [] as unknown[] };
  return {
    calls,
    stub: {
      listContainers: async () => [],
      getContainer: () => ({
        inspect: async () => {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        },
        remove: async (opts: unknown) => {
          calls.remove.push(opts);
        },
        start: async () => {
          calls.start.push({});
        },
        stop: async () => {},
      }),
      createContainer: async (spec: unknown) => {
        calls.create.push(spec);
        return {
          id: "abc",
          start: async () => {
            calls.start.push({});
          },
        };
      },
      getImage: () => ({ inspect: async () => ({}) }),
      pull: (async () => {
        const { Readable } = await import("node:stream");
        return Readable.from([]);
      }) as unknown as DockerodeLike["pull"],
      modem: {
        followProgress: (_stream, onFinished) => onFinished(null, []),
      },
      getNetwork: () => ({ connect: async () => {} }),
    },
  };
}

test("recreate sends spec with sentient.managed label", async () => {
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(true);
  expect((calls.create[0] as { Labels?: Record<string, string> }).Labels?.["sentient.managed"]).toBe("true");
  expect((calls.create[0] as { Labels?: Record<string, string> }).Labels?.["sentient.service"]).toBe("ha-mcp");
});

// WIRE CONTRACT (docker Engine API) + SECURITY. The orchestrator creates
// containers itself via dockerode — compose never runs them — so a `ports:`
// entry in a template only publishes if the driver translates it into
// ExposedPorts + HostConfig.PortBindings. Docker's PortBindings entry defaults
// HostIp to "" which the daemon reads as 0.0.0.0, so the loopback bind must be
// carried through explicitly or every addon lands on the LAN.
test("SECURITY: recreate publishes a loopback port as an explicit 127.0.0.1 PortBinding", async () => {
  const withPort: DockerManagedService = {
    ...ms,
    template: { ...ms.template, ports: ["127.0.0.1:8086:8086"] },
  };
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.recreate(withPort);
  expect(r.ok).toBe(true);
  const spec = calls.create[0] as {
    ExposedPorts?: Record<string, unknown>;
    HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>> };
  };
  expect(spec.ExposedPorts).toEqual({ "8086/tcp": {} });
  expect(spec.HostConfig?.PortBindings).toEqual({ "8086/tcp": [{ HostIp: "127.0.0.1", HostPort: "8086" }] });
});

test("SECURITY: recreate publishes nothing when the template declares no ports", async () => {
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(true);
  const spec = calls.create[0] as {
    ExposedPorts?: Record<string, unknown>;
    HostConfig?: { PortBindings?: Record<string, unknown> };
  };
  expect(spec.ExposedPorts).toEqual({});
  expect(spec.HostConfig?.PortBindings).toEqual({});
});

// Defence in depth: the template schema already rejects this shape, but the
// driver is the last hop before the docker socket and must fail closed rather
// than hand the daemon a binding it would resolve to 0.0.0.0.
test("SECURITY: recreate refuses a template port that does not bind loopback", async () => {
  const bad: DockerManagedService = { ...ms, template: { ...ms.template, ports: ["0.0.0.0:8086:8086"] } };
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.recreate(bad);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
  expect(calls.create.length).toBe(0);
});

test("recreate rejects template whose image is not in allowed_images", async () => {
  const bad: DockerManagedService = { ...ms, template: { ...ms.template, image: "evil/image:v1" } };
  const { stub } = makeStub();
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.recreate(bad);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("listManaged returns only containers with sentient.managed=true label", async () => {
  const stub: DockerodeLike = {
    listContainers: async () => [
      { Id: "1", Labels: { "sentient.managed": "true", "sentient.service": "x" }, Names: ["/x"], State: "running" },
      { Id: "2", Labels: {}, Names: ["/other"], State: "running" },
    ],
    getContainer: () => ({
      inspect: async () => ({}),
      remove: async () => {},
      start: async () => {},
      stop: async () => {},
    }),
    createContainer: async () => ({ id: "x", start: async () => {} }),
    getImage: () => ({ inspect: async () => ({}) }),
    pull: (async () => {
      const { Readable } = await import("node:stream");
      return Readable.from([]);
    }) as unknown as DockerodeLike["pull"],
    modem: { followProgress: (_s, onFinished) => onFinished(null, []) },
    getNetwork: () => ({ connect: async () => {} }),
  };
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.listManaged();
  expect(r.length).toBe(1);
  expect(r[0]?.service).toBe("x");
});

test("recreate tolerates 404 from remove (idempotent recreate)", async () => {
  const { calls } = makeStub();
  const stub: DockerodeLike = {
    listContainers: async () => [],
    getContainer: () => ({
      inspect: async () => {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      },
      remove: async () => {
        throw Object.assign(new Error("no such container"), { statusCode: 404 });
      },
      start: async () => {},
      stop: async () => {},
    }),
    createContainer: async (spec: unknown) => {
      calls.create.push(spec);
      return { id: "abc", start: async () => {} };
    },
    getImage: () => ({ inspect: async () => ({}) }),
    pull: (async () => {
      const { Readable } = await import("node:stream");
      return Readable.from([]);
    }) as unknown as DockerodeLike["pull"],
    modem: { followProgress: (_s, onFinished) => onFinished(null, []) },
    getNetwork: () => ({ connect: async () => {} }),
  };
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(true);
  expect(calls.create.length).toBe(1);
});
