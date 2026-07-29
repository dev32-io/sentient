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
