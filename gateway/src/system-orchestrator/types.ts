import type { Result } from "@sentient/protocol";
import { z } from "zod";

export const ServiceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export type ServiceName = z.infer<typeof ServiceNameSchema>;

export const HealthCheckSchema = z.union([
  z.object({ url: z.string().url(), timeout_ms: z.number().int().positive() }),
  z.object({ tcp: z.string(), timeout_ms: z.number().int().positive() }),
  z.object({ exec: z.array(z.string()).nonempty(), timeout_ms: z.number().int().positive() }),
  // `noop` — orchestrator marks service ready immediately after recreate
  // succeeds, no liveness probe. Use only for services that intentionally
  // bind no port (e.g. supervisord-only) and rely on docker's restart
  // policy to detect crashes.
  z.object({ noop: z.literal(true) }),
]);
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

/** Which backend supervises a managed service: a docker container, or a plain
 *  host process the gateway spawns itself. */
export const LaunchKindSchema = z.enum(["docker", "native"]);
export type LaunchKind = z.infer<typeof LaunchKindSchema>;
export const LAUNCH_KINDS: readonly LaunchKind[] = LaunchKindSchema.options;

/** A pinned interpreter is major.minor only ("3.11"). The patch level is the
 *  host's business; pinning it would break on every security update. */
const PINNED_INTERPRETER_RE = /^\d+\.\d+$/;

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
export type DockerServiceConfig = z.infer<typeof DockerServiceConfigSchema>;

export const NativeServiceConfigSchema = z.object({
  launch: z.literal("native"),
  /** argv; argv[0] is the interpreter or binary. Never shell-interpreted. */
  exec: z.array(z.string().min(1)).nonempty(),
  /** Pinned interpreter, e.g. "3.11". Verified by prepare() before start. */
  python: z.string().regex(PINNED_INTERPRETER_RE).optional(),
  env: z.record(z.string(), z.string()).optional().default({}),
  cwd: z.string().optional(),
  ...CommonServiceFields,
});
export type NativeServiceConfig = z.infer<typeof NativeServiceConfigSchema>;

/** `launch` defaults to "docker" so every pre-existing entry parses unchanged.
 *  A discriminated union cannot express that default on its own — the key must
 *  exist before discrimination, hence the preprocess. */
export const ManagedServiceConfigSchema = z.preprocess(
  (raw) => (typeof raw === "object" && raw !== null && !("launch" in raw) ? { ...raw, launch: "docker" } : raw),
  z.discriminatedUnion("launch", [DockerServiceConfigSchema, NativeServiceConfigSchema]),
);
export type ManagedServiceConfig = z.infer<typeof ManagedServiceConfigSchema>;

/** Host port publishing, `127.0.0.1:<host>:<container>`. The gateway is native
 *  now, so it can no longer reach addons over the docker network — on macOS
 *  Docker Desktop bridge IPs are not host-routable, so publishing is
 *  unavoidable. It MUST bind loopback: docker's default bind for a bare
 *  "8086:8086" is 0.0.0.0, which would expose every MCP to the LAN. */
export const LOOPBACK_PORT_RE = /^127\.0\.0\.1:\d{1,5}:\d{1,5}$/;
export const LOOPBACK_PORT_REASON = "ports must bind 127.0.0.1 explicitly (127.0.0.1:host:container)";

const LoopbackPortSchema = z.string().regex(LOOPBACK_PORT_RE, LOOPBACK_PORT_REASON);

/** Parsed YAML template body. `ports` are loopback-only (see above). Any volume
 *  must be bind-mountable from a path the gateway controls. */
export const ServiceTemplateSchema = z.object({
  image: z.string().min(1),
  container_name: z.string().min(1),
  networks: z.array(z.string().min(1)).nonempty(),
  env: z.record(z.string(), z.string()).optional().default({}),
  volumes: z.array(z.string()).optional().default([]),
  command: z.array(z.string()).optional(),
  extra_hosts: z.array(z.string()).optional().default([]),
  mem_limit_bytes: z.number().int().positive().optional(),
  cpus: z.number().positive().optional(),
  group_add: z.array(z.string()).optional().default([]),
  ports: z.array(LoopbackPortSchema).optional().default([]),
});
export type ServiceTemplate = z.infer<typeof ServiceTemplateSchema>;

/** State exposed for UI + apply-bar consumption. */
export type ServiceState =
  | "pending"
  | "starting"
  | "health-checking"
  | "ready"
  | "degraded"
  | "failed"
  | "blocked-by-dep"
  | "pending-secrets";

export interface ServiceStatus {
  name: ServiceName;
  state: ServiceState;
  optional: boolean;
  version: string | null;
  lastError: string | null;
}

export interface OrchestratorStatus {
  state: "idle" | "planning" | "applying" | "ready" | "failed";
  services: ServiceStatus[];
  startedAt: number | null;
  finishedAt: number | null;
}

/** A docker-backed service carries the rendered container template. */
export type DockerManagedService = {
  name: ServiceName;
  config: DockerServiceConfig;
  template: ServiceTemplate;
};

/** A native-backed service has no container template — its whole runtime spec
 *  is the argv, env and cwd already on the config. */
export type NativeManagedService = {
  name: ServiceName;
  config: NativeServiceConfig;
};

export type ManagedService = DockerManagedService | NativeManagedService;

// TypeScript does not narrow a union through a NESTED discriminant
// (`ms.config.launch`), so callers narrow through these guards instead.
export function isDockerService(ms: ManagedService): ms is DockerManagedService {
  return ms.config.launch === "docker";
}

export function isNativeService(ms: ManagedService): ms is NativeManagedService {
  return ms.config.launch === "native";
}

/** Backend-agnostic driver failure. Closed `kind` set so the apply bar can map
 *  a reason to UI copy without knowing which backend produced it. */
export type DriverErrorKind =
  | "policy-violation"
  | "create-failed"
  | "remove-failed"
  | "stop-failed"
  | "start-failed"
  | "pull-failed"
  | "image-missing"
  | "prepare-failed"
  | "spawn-failed"
  | "wrong-backend";

export type DriverError = { kind: DriverErrorKind; reason: string };

/** One live unit of a managed service: a container for docker, a process group
 *  for native. `id` is the handle that backend's own `remove()` accepts — a
 *  container id for docker, the service name for native — so a reconciler can
 *  reap what it lists without knowing which backend produced it. */
export interface ManagedProcessInfo {
  id: string;
  service: ServiceName;
  state: string;
}

/** The seam every backend implements. Everything above it — dep-graph, health
 *  polling, boot reconciliation — stays backend-agnostic. */
export interface ServiceDriver {
  /** Ensure the launch artifact exists: pull the image (docker) or verify the
   *  venv and its pinned interpreter (native). Idempotent. */
  prepare(ms: ManagedService): Promise<Result<undefined, DriverError>>;
  recreate(ms: ManagedService): Promise<Result<undefined, DriverError>>;
  start(name: ServiceName): Promise<Result<undefined, DriverError>>;
  stop(name: ServiceName): Promise<Result<undefined, DriverError>>;
  remove(name: ServiceName): Promise<Result<undefined, DriverError>>;
  listManaged(): Promise<ManagedProcessInfo[]>;
}
