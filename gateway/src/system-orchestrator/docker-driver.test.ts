import { expect, test } from "bun:test";
import { type DockerodeLike, createDockerDriver } from "./docker-driver.js";
import type { DockerManagedService, ManagedNetworks } from "./types.js";

const NETWORKS: ManagedNetworks = {
  "sentient-internal": { internal: true },
  "sentient-external": { internal: false },
};

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
    infra: false,
    public_ports: false,
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

function makeStub(): {
  stub: DockerodeLike;
  calls: {
    create: unknown[];
    remove: unknown[];
    start: Array<{ netConnectsAtStart: number }>;
    createNetwork: unknown[];
    netConnect: Array<{ network: string; container: string }>;
  };
} {
  const calls = {
    create: [] as unknown[],
    remove: [] as unknown[],
    // `netConnectsAtStart` snapshots how many extra networks were attached
    // before the container was started — see the two-network attach test.
    start: [] as Array<{ netConnectsAtStart: number }>,
    createNetwork: [] as unknown[],
    netConnect: [] as Array<{ network: string; container: string }>,
  };
  // Tracks the one container `createContainer`/`remove` last acted on, keyed by
  // name — enough for `inspect()` to answer "running, with these Labels" for
  // the skip-recreate tests, and to 404 before anything has been created (or
  // after it has since been removed).
  let running: { name: string; spec: Record<string, unknown> } | undefined;
  return {
    calls,
    stub: {
      listNetworks: async () => [
        { Name: "sentient-internal", Internal: true },
        { Name: "sentient-external", Internal: false },
      ],
      createNetwork: async (spec: unknown) => {
        calls.createNetwork.push(spec);
      },
      listContainers: async () => [],
      getContainer: (name: string) => ({
        inspect: async () => {
          if (running?.name === name) {
            return { State: { Running: true }, Config: { Labels: running.spec.Labels } };
          }
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        },
        remove: async (opts: unknown) => {
          calls.remove.push(opts);
          if (running?.name === name) running = undefined;
        },
        start: async () => {
          calls.start.push({ netConnectsAtStart: calls.netConnect.length });
        },
        stop: async () => {},
      }),
      createContainer: async (spec: unknown) => {
        calls.create.push(spec);
        running = { name: (spec as { name: string }).name, spec: spec as Record<string, unknown> };
        return {
          id: "abc",
          start: async () => {
            calls.start.push({ netConnectsAtStart: calls.netConnect.length });
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
      getNetwork: (name: string) => ({
        connect: async (opts: { Container: string }) => {
          calls.netConnect.push({ network: name, container: opts.Container });
        },
      }),
    },
  };
}

test("recreate sends spec with sentient.managed label", async () => {
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
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
    config: { ...ms.config, networks: ["sentient-internal", "sentient-external"] },
    template: { ...ms.template, networks: ["sentient-internal", "sentient-external"], ports: ["127.0.0.1:8086:8086"] },
  };
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
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
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(true);
  const spec = calls.create[0] as {
    ExposedPorts?: Record<string, unknown>;
    HostConfig?: { PortBindings?: Record<string, unknown> };
  };
  expect(spec.ExposedPorts).toEqual({});
  expect(spec.HostConfig?.PortBindings).toEqual({});
});

// EMPIRICAL INVARIANT, verified against the real daemon (docker 29.2.1): docker
// SILENTLY DROPS port publishing for a container whose every attached network is
// `internal: true`. `HostConfig.PortBindings` still reads back exactly as sent,
// but `NetworkSettings.Ports` is EMPTY and the host port answers nothing —
// `docker run -d --network sentient-internal -p 127.0.0.1:19991:8088` gave
// `Ports={"8088/tcp":[]}`, while the identical run on the non-internal
// `sentient-external` published and answered. So a template with `ports:` and
// only-internal networks is unreachable, and the failure surfaces one layer
// later as a bare ECONNREFUSED from the health probe that names nothing.
// Fail closed at the driver, naming the cause.
test("SECURITY: recreate refuses to publish a port when every attached network is internal", async () => {
  const unreachable: DockerManagedService = {
    ...ms,
    template: { ...ms.template, ports: ["127.0.0.1:8088:8088"] },
  };
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(unreachable);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
  expect(r.error.reason).toContain("internal");
  expect(calls.create.length).toBe(0);
});

// WIRE CONTRACT (docker Engine API) + SECURITY. `ingress-proxy` is the ONLY
// container that spans sentient-internal and sentient-external, and the whole
// addon ingress path depends on it holding BOTH: external carries the publish
// (docker drops it when every attached network is internal, see above),
// internal carries the hop to the confined MCPs. Docker honours only the FIRST
// entry of NetworkingConfig.EndpointsConfig at create time, so the rest must go
// through network.connect — and before start(), or nginx boots resolving
// upstreams on a network it is not yet on. A regression here is silent: the
// container comes up on one network and either loses its publish or cannot
// reach anything it fronts.
test("SECURITY: a two-network service attaches the second network via connect BEFORE start", async () => {
  const spanning: DockerManagedService = {
    ...ms,
    name: "ingress-proxy",
    config: { ...ms.config, networks: ["sentient-internal", "sentient-external"] },
    template: {
      ...ms.template,
      container_name: "sentient-ingress-proxy",
      networks: ["sentient-internal", "sentient-external"],
      ports: ["127.0.0.1:8088:8088"],
    },
  };
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(spanning);
  expect(r.ok).toBe(true);
  // First network rides the create spec; every later one is a connect call.
  expect(calls.netConnect).toEqual([{ network: "sentient-external", container: "abc" }]);
  expect(calls.start.length).toBe(1);
  expect(calls.start[0]?.netConnectsAtStart).toBe(1);
});

// Defence in depth: the template schema already rejects this shape, but the
// driver is the last hop before the docker socket and must fail closed rather
// than hand the daemon a binding it would resolve to 0.0.0.0.
test("SECURITY: recreate refuses a template port that does not bind loopback", async () => {
  const bad: DockerManagedService = { ...ms, template: { ...ms.template, ports: ["0.0.0.0:8086:8086"] } };
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(bad);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
  expect(calls.create.length).toBe(0);
});

// The gateway is the host orchestrator now — nothing else creates the addon
// networks. `docker compose up` creates NO networks when every service is
// build-only (verified against docker 29.2.1: "no service selected"), so the
// gateway must ensure them itself or every container create fails with
// "network not found".
test("recreate creates a missing addon network before creating the container", async () => {
  const { stub, calls } = makeStub();
  stub.listNetworks = async () => [];
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(true);
  expect(calls.createNetwork).toEqual([{ Name: "sentient-internal", Driver: "bridge", Internal: true }]);
});

// SECURITY: `sentient-internal` carries `internal: true` — it is what stops
// every MCP from reaching the internet directly instead of through
// egress-proxy. A network auto-created WITHOUT the flag looks identical in
// `docker network ls` and silently voids the egress boundary.
test("SECURITY: an auto-created internal network carries the no-egress flag", async () => {
  const { stub, calls } = makeStub();
  stub.listNetworks = async () => [];
  const external: DockerManagedService = {
    ...ms,
    config: { ...ms.config, networks: ["sentient-external"] },
    template: { ...ms.template, networks: ["sentient-external"] },
  };
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  await drv.recreate(ms);
  await drv.recreate(external);
  expect(calls.createNetwork).toEqual([
    { Name: "sentient-internal", Driver: "bridge", Internal: true },
    { Name: "sentient-external", Driver: "bridge", Internal: false },
  ]);
});

test("recreate does not recreate a network that already exists", async () => {
  const { stub, calls } = makeStub();
  stub.listNetworks = async () => [{ Name: "sentient-internal", Internal: true }];
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(true);
  expect(calls.createNetwork).toEqual([]);
});

// SECURITY: the egress boundary is `sentient-internal` carrying docker's
// Internal flag — nothing else enforces it. Every MCP is confined to it and
// reached through `ingress-proxy`, so this one flag is what makes fetch-mcp's
// direct egress impossible rather than merely discouraged. A network that
// already exists is adopted by
// name, and a same-named network created by hand or by an old compose file
// (`docker network create sentient-internal`, Internal=false) is
// indistinguishable in `docker network ls`. Adopting it would attach every addon
// to a routable bridge while the topology still claims confinement. Fail closed
// on the drift instead of trusting the name.
test("SECURITY: recreate refuses an existing network whose internal flag drifted from the topology", async () => {
  const { stub, calls } = makeStub();
  stub.listNetworks = async () => [{ Name: "sentient-internal", Internal: false }];
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
  expect(r.error.reason).toContain("internal");
  expect(calls.create.length).toBe(0);
  expect(calls.createNetwork).toEqual([]);
});

// Fail closed: an undeclared network has no known `internal` flag, so guessing
// one would be guessing at the egress boundary.
test("SECURITY: recreate refuses a network absent from the declared topology", async () => {
  const { stub, calls } = makeStub();
  stub.listNetworks = async () => [];
  const rogue: DockerManagedService = {
    ...ms,
    config: { ...ms.config, networks: ["rogue-net"] },
    template: { ...ms.template, networks: ["rogue-net"] },
  };
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(rogue);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
  expect(calls.create.length).toBe(0);
});

test("recreate rejects template whose image is not in allowed_images", async () => {
  const bad: DockerManagedService = { ...ms, template: { ...ms.template, image: "evil/image:v1" } };
  const { stub } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(bad);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("listManaged returns only containers with sentient.managed=true label", async () => {
  const stub: DockerodeLike = {
    listNetworks: async () => [{ Name: "sentient-internal", Internal: true }],
    createNetwork: async () => {},
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
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.listManaged();
  expect(r.length).toBe(1);
  expect(r[0]?.service).toBe("x");
});

test("CONTRACT: an unreachable docker daemon yields an empty list, never a rejection", async () => {
  // launchd starts the gateway before auto-login has started Docker Desktop, so
  // `listContainers` rejecting with ECONNREFUSED is a routine boot state. It
  // used to escape all the way out of the boot reconcile, which then never
  // armed the post-boot health watchdog — leaving every addon, docker AND
  // native, with no crash recovery for the whole process lifetime.
  const stub: DockerodeLike = {
    listNetworks: async () => [{ Name: "sentient-internal", Internal: true }],
    createNetwork: async () => {},
    listContainers: async () => {
      throw Object.assign(new Error("connect ENOENT /var/run/docker.sock"), { code: "ENOENT" });
    },
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
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });

  expect(await drv.listManaged()).toEqual([]);
});

// SECURITY: the §2.3 public-port exception. Granted per-service in POLICY
// (config.yaml#managed_services.<svc>.public_ports), never in the template —
// this is the last of the three enforcement layers, the one that actually
// writes HostIp onto the docker socket.
test("SECURITY: recreate writes HostIp 0.0.0.0 for a granted public port", async () => {
  const granted: DockerManagedService = {
    ...ms,
    config: { ...ms.config, public_ports: true, networks: ["sentient-external"] },
    template: { ...ms.template, networks: ["sentient-external"], ports: ["0.0.0.0:443:8443"] },
  };
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(granted);
  expect(r.ok).toBe(true);
  const spec = calls.create[0] as {
    HostConfig?: { PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }>> };
  };
  expect(spec.HostConfig?.PortBindings?.["8443/tcp"]).toEqual([{ HostIp: "0.0.0.0", HostPort: "443" }]);
});

test("SECURITY: recreate refuses a public port when the service's policy does not grant it", async () => {
  const notGranted: DockerManagedService = {
    ...ms,
    config: { ...ms.config, public_ports: false, networks: ["sentient-external"] },
    template: { ...ms.template, networks: ["sentient-external"], ports: ["0.0.0.0:443:8443"] },
  };
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(notGranted);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
  expect(calls.create.length).toBe(0);
});

test("recreate tolerates 404 from remove (idempotent recreate)", async () => {
  const { calls } = makeStub();
  const stub: DockerodeLike = {
    listNetworks: async () => [{ Name: "sentient-internal", Internal: true }],
    createNetwork: async () => {},
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
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(true);
  expect(calls.create.length).toBe(1);
});

// INVARIANT, documented in spec-hash.ts: under `bun --watch` the gateway
// restarts on every source save, and an unconditional recreate would drop the
// public door (80/443) on every keystroke. An infra service already running
// with the exact spec we would create is left alone. This does NOT skip
// verifyIdentity — that runs afterward, in the orchestrator, regardless — so a
// foreign process holding the port is still caught.
test("INFRA: recreate skips an already-running infra container with a matching spec hash", async () => {
  const { stub, calls } = makeStub();
  const infra: DockerManagedService = {
    ...ms,
    config: { ...ms.config, infra: true, public_ports: true, networks: ["sentient-external"] },
    template: { ...ms.template, networks: ["sentient-external"], ports: ["0.0.0.0:443:8443"] },
  };
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });

  const first = await drv.recreate(infra);
  expect(first.ok).toBe(true);
  const createdOnce = calls.create.length;
  const removedOnce = calls.remove.length;

  const second = await drv.recreate(infra);

  expect(second.ok).toBe(true);
  expect(calls.create.length).toBe(createdOnce); // no second create
  expect(calls.remove.length).toBe(removedOnce); // and nothing torn down
});

// The skip is gated on a hash match, not merely on "infra and running" — a
// changed spec (here, an added env var) must still recreate, or the operator
// loses the ability to ever change the public door's config.
test("INFRA: recreate still recreates an infra container whose spec changed", async () => {
  const { stub, calls } = makeStub();
  const infra: DockerManagedService = {
    ...ms,
    config: { ...ms.config, infra: true, public_ports: true, networks: ["sentient-external"] },
    template: { ...ms.template, networks: ["sentient-external"], ports: ["0.0.0.0:443:8443"] },
  };
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });
  await drv.recreate(infra);
  const createdOnce = calls.create.length;

  const changed: DockerManagedService = { ...infra, template: { ...infra.template, env: { CHANGED: "1" } } };
  const r = await drv.recreate(changed);

  expect(r.ok).toBe(true);
  expect(calls.create.length).toBe(createdOnce + 1);
});

// The skip is gated on `ms.config.infra` — a capability addon (infra: false)
// is cheap to recreate, so it always does, even when nothing changed.
test("recreate always recreates a non-infra container even when unchanged", async () => {
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub, networks: NETWORKS });

  await drv.recreate(ms);
  const createdOnce = calls.create.length;
  await drv.recreate(ms);

  expect(calls.create.length).toBe(createdOnce + 1);
});
