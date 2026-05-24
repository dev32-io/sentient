import type { Readable } from "node:stream";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ManagedService, ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "docker-driver"]);

const LABEL_MANAGED = "sentient.managed";
const LABEL_SERVICE = "sentient.service";

export type DockerError =
  | { kind: "policy-violation"; reason: string }
  | { kind: "create-failed"; reason: string }
  | { kind: "remove-failed"; reason: string }
  | { kind: "stop-failed"; reason: string }
  | { kind: "start-failed"; reason: string }
  | { kind: "pull-failed"; reason: string }
  | { kind: "image-missing"; reason: string };

export interface ManagedContainerInfo {
  id: string;
  service: ServiceName;
  state: string;
}

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

export interface DockerDriver {
  recreate(ms: ManagedService): Promise<Result<undefined, DockerError>>;
  start(name: string): Promise<Result<undefined, DockerError>>;
  stop(name: string): Promise<Result<undefined, DockerError>>;
  remove(name: string): Promise<Result<undefined, DockerError>>;
  pullImage(image: string): Promise<Result<undefined, DockerError>>;
  listManaged(): Promise<ManagedContainerInfo[]>;
}

export interface DockerDriverDeps {
  docker: DockerodeLike;
}

export function createDockerDriver(deps: DockerDriverDeps): DockerDriver {
  return {
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
    pullImage: (image) => pullImageDraining(deps.docker, image),
    listManaged: async () => listManaged(deps.docker),
  };
}

async function recreate(docker: DockerodeLike, ms: ManagedService): Promise<Result<undefined, DockerError>> {
  const policy = enforcePolicy(ms);
  if (!policy.ok) return policy;

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

  const spec = buildCreateSpec(ms);
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

function enforcePolicy(ms: ManagedService): Result<undefined, DockerError> {
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

function buildCreateSpec(ms: ManagedService): Record<string, unknown> {
  const env = Object.entries(ms.template.env).map(([k, v]) => `${k}=${v}`);
  const primaryNet = ms.template.networks[0] ?? "";
  return {
    name: ms.template.container_name,
    Image: ms.template.image,
    Cmd: ms.template.command,
    Env: env,
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
      // Explicit empty PortBindings — defense in depth against accidental
      // host-port exposure.
      PortBindings: {},
    },
    // NetworkingConfig is intentionally omitted — Docker only honours the
    // first entry at create time, so secondary networks would be silently
    // dropped here. They are attached after create via network.connect.
  };
}

async function listManaged(docker: DockerodeLike): Promise<ManagedContainerInfo[]> {
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

/** Pull an image, draining the progress stream so the pull actually completes
 *  before resolution. dockerode's `pull` returns a readable progress stream;
 *  awaiting the call alone resolves the moment the stream is opened, NOT when
 *  the pull finishes. `modem.followProgress` is the canonical drain helper. */
async function pullImageDraining(docker: DockerodeLike, image: string): Promise<Result<undefined, DockerError>> {
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
async function ensureImageAvailable(docker: DockerodeLike, image: string): Promise<Result<undefined, DockerError>> {
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
