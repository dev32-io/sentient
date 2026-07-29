import type { Readable } from "node:stream";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import {
  type DockerManagedService,
  type DriverError,
  LOOPBACK_PORT_RE,
  LOOPBACK_PORT_REASON,
  type ManagedProcessInfo,
  type ManagedService,
  type ServiceDriver,
  isDockerService,
} from "./types.js";

const log = getLog(["sentient", "system-orch", "docker-driver"]);

const LABEL_MANAGED = "sentient.managed";
const LABEL_SERVICE = "sentient.service";

/** The only host address an addon may be published on. Docker treats an empty
 *  `HostIp` as 0.0.0.0, so this is written explicitly into every binding. */
const LOOPBACK_HOST_IP = "127.0.0.1";
/** Docker keys ExposedPorts/PortBindings by `<port>/<proto>`; addons are TCP. */
const PORT_PROTO = "tcp";

/** Narrow surface we need from dockerode — keeps tests free of any real socket.
 *  `pull` returns dockerode's progress stream; the caller drains it via
 *  `modem.followProgress` so the pull actually completes (and errors surface)
 *  before we try to use the image. */
export interface DockerodeLike {
  listContainers(opts?: { all?: boolean; filters?: string }): Promise<
    Array<{
      Id: string;
      Labels: Record<string, string>;
      Names: string[];
      State: string;
    }>
  >;
  getContainer(id: string): {
    inspect(): Promise<unknown>;
    remove(opts?: { force?: boolean }): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  getImage(name: string): { inspect(): Promise<unknown> };
  createContainer(spec: Record<string, unknown>): Promise<{ id: string; start(): Promise<void> }>;
  getNetwork(name: string): { connect(opts: { Container: string }): Promise<void> };
  pull(image: string): Promise<Readable>;
  modem: {
    followProgress(
      stream: Readable,
      onFinished: (err: Error | null, output: unknown) => void,
      onProgress?: (event: unknown) => void,
    ): void;
  };
}

export interface DockerDriverDeps {
  docker: DockerodeLike;
}

export function createDockerDriver(deps: DockerDriverDeps): ServiceDriver {
  return {
    prepare: (ms) => prepare(deps.docker, ms),
    recreate: (ms) => recreate(deps.docker, ms),
    start: async (name) => {
      try {
        await deps.docker.getContainer(name).start();
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: { kind: "start-failed", reason: errMsg(err) } };
      }
    },
    stop: async (name) => {
      try {
        await deps.docker.getContainer(name).stop();
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: { kind: "stop-failed", reason: errMsg(err) } };
      }
    },
    remove: async (name) => {
      try {
        await deps.docker.getContainer(name).remove({ force: true });
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: { kind: "remove-failed", reason: errMsg(err) } };
      }
    },
    listManaged: async () => listManaged(deps.docker),
  };
}

/** Ensure the launch artifact exists — for docker, the image on the host
 *  daemon. The native driver's analogue verifies the venv and its pinned
 *  interpreter; both are idempotent and safe to re-run. */
async function prepare(docker: DockerodeLike, ms: ManagedService): Promise<Result<undefined, DriverError>> {
  if (!isDockerService(ms)) return wrongBackend(ms);
  return ensureImageAvailable(docker, ms.template.image);
}

async function recreate(docker: DockerodeLike, ms: ManagedService): Promise<Result<undefined, DriverError>> {
  if (!isDockerService(ms)) return wrongBackend(ms);
  const policy = enforcePolicy(ms);
  if (!policy.ok) return policy;

  // Resolve publishing BEFORE the teardown below: a rejected port mapping must
  // leave the currently-running container alone rather than remove it and then
  // refuse to create its replacement.
  const published = buildPortPublishing(ms);
  if (!published.ok) return published;

  // Ensure the image is available BEFORE we tear down the existing container.
  // Public images (e.g. kalaksi/tinyproxy:latest) get pulled here; locally-
  // built `:local` tags fail to pull but exist on the host daemon — tolerate
  // pull failure if the image is already present locally.
  const ensured = await ensureImageAvailable(docker, ms.template.image);
  if (!ensured.ok) return ensured;

  // Best-effort remove: tolerate 404, surface other errors.
  try {
    await docker.getContainer(ms.template.container_name).remove({ force: true });
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode !== 404) {
      return { ok: false, error: { kind: "remove-failed", reason: errMsg(err) } };
    }
  }

  const spec = buildCreateSpec(ms, published.value);
  let created: { id: string; start: () => Promise<void> };
  try {
    created = await docker.createContainer(spec);
  } catch (err) {
    return { ok: false, error: { kind: "create-failed", reason: errMsg(err) } };
  }
  // Docker only honours the FIRST entry in NetworkingConfig.EndpointsConfig at
  // create time. Attach to remaining networks via network.connect BEFORE start
  // so DNS resolution works on every network the template lists.
  const otherNets = ms.template.networks.slice(1);
  for (const net of otherNets) {
    try {
      await docker.getNetwork(net).connect({ Container: created.id });
    } catch (err) {
      return { ok: false, error: { kind: "create-failed", reason: `network.connect ${net}: ${errMsg(err)}` } };
    }
  }
  try {
    await created.start();
  } catch (err) {
    return { ok: false, error: { kind: "start-failed", reason: errMsg(err) } };
  }
  log.info("driver.recreated", { service: ms.name, id: created.id });
  return { ok: true, value: undefined };
}

function enforcePolicy(ms: DockerManagedService): Result<undefined, DriverError> {
  if (!ms.config.allowed_images.includes(ms.template.image)) {
    return { ok: false, error: { kind: "policy-violation", reason: `image ${ms.template.image} not allowed` } };
  }
  for (const net of ms.template.networks) {
    if (!ms.config.networks.includes(net)) {
      return { ok: false, error: { kind: "policy-violation", reason: `network ${net} not allowed` } };
    }
  }
  return { ok: true, value: undefined };
}

/** Docker Engine API port publishing, split into the two fields `createContainer`
 *  needs. `ExposedPorts` declares the container-side port; `PortBindings` maps it
 *  to a host address. The `HostIp` is written EXPLICITLY — an omitted or empty
 *  HostIp means 0.0.0.0 to the daemon, i.e. the addon on every LAN interface. */
interface PortPublishing {
  exposed: Record<string, Record<string, never>>;
  bindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
}

function buildPortPublishing(ms: DockerManagedService): Result<PortPublishing, DriverError> {
  const out: PortPublishing = { exposed: {}, bindings: {} };
  for (const entry of ms.template.ports) {
    if (!LOOPBACK_PORT_RE.test(entry)) {
      const reason = `${LOOPBACK_PORT_REASON}; got ${entry}`;
      log.warn("driver.port-policy-violation", { service: ms.name, reason });
      return { ok: false, error: { kind: "policy-violation", reason } };
    }
    const [, hostPort, containerPort] = entry.split(":");
    const key = `${containerPort}/${PORT_PROTO}`;
    out.exposed[key] = {};
    out.bindings[key] = [{ HostIp: LOOPBACK_HOST_IP, HostPort: hostPort ?? "" }];
  }
  if (ms.template.ports.length > 0) {
    log.info("driver.ports-published", { service: ms.name, ports: ms.template.ports });
  }
  return { ok: true, value: out };
}

function buildCreateSpec(ms: DockerManagedService, published: PortPublishing): Record<string, unknown> {
  const env = Object.entries(ms.template.env).map(([k, v]) => `${k}=${v}`);
  const primaryNet = ms.template.networks[0] ?? "";
  return {
    name: ms.template.container_name,
    Image: ms.template.image,
    Cmd: ms.template.command,
    Env: env,
    ExposedPorts: published.exposed,
    Labels: {
      [LABEL_MANAGED]: "true",
      [LABEL_SERVICE]: ms.name,
    },
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
      // Loopback-only, built by buildPortPublishing. Empty when the template
      // declares no ports — defence in depth against accidental exposure.
      PortBindings: published.bindings,
    },
    // NetworkingConfig is intentionally omitted — Docker only honours the
    // first entry at create time, so secondary networks would be silently
    // dropped here. They are attached after create via network.connect.
  };
}

async function listManaged(docker: DockerodeLike): Promise<ManagedProcessInfo[]> {
  const filters = JSON.stringify({ label: [`${LABEL_MANAGED}=true`] });
  const list = await docker.listContainers({ all: true, filters });
  return list
    .filter((c) => c.Labels?.[LABEL_MANAGED] === "true")
    .map((c) => ({
      id: c.Id,
      service: c.Labels[LABEL_SERVICE] ?? "unknown",
      state: c.State,
    }));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fail closed when a native service reaches the docker driver. */
function wrongBackend(ms: ManagedService): Result<undefined, DriverError> {
  const reason = `service ${ms.name} is launch=${ms.config.launch}, not docker`;
  log.warn("driver.wrong-backend", { service: ms.name, reason });
  return { ok: false, error: { kind: "wrong-backend", reason } };
}

/** Pull an image, draining the progress stream so the pull actually completes
 *  before resolution. dockerode's `pull` returns a readable progress stream;
 *  awaiting the call alone resolves the moment the stream is opened, NOT when
 *  the pull finishes. `modem.followProgress` is the canonical drain helper. */
async function pullImageDraining(docker: DockerodeLike, image: string): Promise<Result<undefined, DriverError>> {
  let stream: Readable;
  try {
    stream = await docker.pull(image);
  } catch (err) {
    return { ok: false, error: { kind: "pull-failed", reason: errMsg(err) } };
  }
  return new Promise((resolve) => {
    docker.modem.followProgress(stream, (err) => {
      if (err) {
        resolve({ ok: false, error: { kind: "pull-failed", reason: errMsg(err) } });
        return;
      }
      resolve({ ok: true, value: undefined });
    });
  });
}

/** Ensure `image` exists on the host daemon. Try `pull` first; on failure,
 *  fall back to a local `getImage().inspect()` check. Local-built tags
 *  (`sentient/<svc>:local`) can't be pulled but exist locally — they should
 *  succeed. Foreign images that fail to pull AND aren't local fail outright. */
async function ensureImageAvailable(docker: DockerodeLike, image: string): Promise<Result<undefined, DriverError>> {
  const pull = await pullImageDraining(docker, image);
  if (pull.ok) return pull;

  try {
    await docker.getImage(image).inspect();
    log.warn("recreate.pull-failed-using-local", { image, reason: pull.error.reason });
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: { kind: "image-missing", reason: pull.error.reason } };
  }
}
