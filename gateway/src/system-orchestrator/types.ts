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

/** Docker network topology the addons attach to. The gateway is the host
 *  orchestrator now, so nothing upstream creates these — `docker compose up`
 *  creates no networks when every remaining compose service is build-only. The
 *  gateway therefore creates them itself, and needs each network's egress
 *  posture declared rather than guessed: `internal: true` is what confines an
 *  addon to the egress-proxy hop. */
export interface ManagedNetworkConfig {
  /** docker's `Internal` flag — true blocks all egress from the network. */
  internal: boolean;
}

export type ManagedNetworks = Readonly<Record<string, ManagedNetworkConfig>>;

/** The closed set of addon networks, and the ONLY place their egress posture is
 *  declared. Deliberately NOT a config key: `internal: true` on
 *  sentient-internal is the security invariant that forces every MCP through
 *  egress-proxy, and an operator flipping it in YAML would void that boundary
 *  invisibly (a non-internal network looks identical in `docker network ls`).
 *  Per-service network MEMBERSHIP stays operator-declared in
 *  `config.yaml#managed_services.<svc>.networks`; the driver fails closed on
 *  any membership naming a network outside this map. */
export const MANAGED_NETWORK_TOPOLOGY: ManagedNetworks = Object.freeze({
  "sentient-internal": { internal: true },
  "sentient-external": { internal: false },
  // The PUBLIC edge, and deliberately its own segment. inbound-proxy's only
  // upstream is host loopback — it needs zero container reachability. Putting it
  // on sentient-external instead would share an L2 segment with ha-mcp, ma-mcp,
  // searxng-mcp and egress-proxy, handing the one internet-facing container
  // lateral reach it has no use for. Non-internal because docker silently drops
  // port publishing when every attached network is internal.
  "sentient-edge": { internal: false },
});

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
  /** INFRASTRUCTURE class. A capability addon can wait for the wizard, be given
   *  up on, and be recreated freely. The public door cannot: waiting for the
   *  wizard means no route TO the wizard on a fresh host, giving up means the
   *  only entrance stays dead until someone notices, and recreating on every
   *  `bun --watch` save drops 80/443 on every keystroke.
   *
   *  Three behaviours change, all fail-safe in the false direction:
   *    - applied before bootstrap completes  (bootstrap/phase-orchestrator.ts)
   *    - never given up on by the watchdog   (system-orchestrator/health-watch.ts)
   *    - not recreated when unchanged+healthy (system-orchestrator/docker-driver.ts)
   *
   *  Default false: every pre-existing entry keeps today's behaviour exactly. */
  infra: z.boolean().optional().default(false),
};

export const DockerServiceConfigSchema = z.object({
  launch: z.literal("docker"),
  template: z.string().min(1),
  allowed_images: z.array(z.string().min(1)).nonempty(),
  networks: z.array(z.string().min(1)).nonempty(),
  secrets: z.record(z.string(), z.string()).optional().default({}),
  /** Grants this service the §2.3 public-port exception. Default false, so the
   *  loopback rule holds for every entry that does not name it explicitly.
   *  Separate from `infra`: one is a lifecycle class, this is an exposure grant,
   *  and coupling them would mean any future infra service silently gained the
   *  right to bind 0.0.0.0. */
  public_ports: z.boolean().optional().default(false),
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

/** The ONE exception to the loopback rule, and it is deliberately not general.
 *  `0.0.0.0:<80|443>:<container>` only, and only for a service whose POLICY
 *  entry sets `public_ports: true` — the template alone can never grant it.
 *
 *  Two locks, because either alone is one edit away from opening every addon to
 *  the LAN: the host port is pinned to the two ports a web entrance actually
 *  needs, and the grant lives in operator config rather than in the template a
 *  service ships with. */
export const PUBLIC_PORT_RE = /^0\.0\.0\.0:(80|443):\d{1,5}$/;
export const PUBLIC_PORT_REASON =
  "a public publish must be 0.0.0.0:80 or 0.0.0.0:443 AND the service's config must set public_ports: true";

/** Single source of truth for "may this template publish this mapping". Read by
 *  all three enforcement layers (schema, template-loader, docker-driver) so they
 *  cannot drift — the previous duplication of LOOPBACK_PORT_RE across the three
 *  is the pattern this replaces. */
export function isAllowedPortMapping(entry: string, allowPublic: boolean): boolean {
  if (LOOPBACK_PORT_RE.test(entry)) return true;
  return allowPublic && PUBLIC_PORT_RE.test(entry);
}

/** Schema-level layer. It cannot see policy, so it admits the SHAPE of both and
 *  leaves the grant check to the loader and driver, which do see policy — hence
 *  `allowPublic: true` here: this layer validates shape only, never a grant. */
const PortMappingSchema = z
  .string()
  .refine((v) => isAllowedPortMapping(v, true), `${LOOPBACK_PORT_REASON}; ${PUBLIC_PORT_REASON}`);

/** Parsed YAML template body. `ports` are loopback-only by default, with the one
 *  narrow public exception above (see PUBLIC_PORT_RE). Any volume must be
 *  bind-mountable from a path the gateway controls. */
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
  ports: z.array(PortMappingSchema).optional().default([]),
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
  // The port answers, but not with OUR unit on the other end — a leftover, a
  // foreign daemon, or an impostor. Liveness passed and identity did not.
  | "identity-failed"
  // Refused to launch: something the gateway did not start already holds the
  // service's port, and killing a process we cannot identify as ours is not a
  // decision an unattended supervisor gets to take. The reason names the holder.
  | "port-held"
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
  /**
   * IDENTITY half of the health contract, run after the config healthcheck
   * passes. A port probe proves only that *something* answers on 127.0.0.1:N;
   * this proves the answerer is the unit this driver started.
   *
   * It exists because liveness alone let a day-old orphan hold whisper-stt's
   * port while the orchestrator reported the fleet `ready` with both native
   * addons dead. whisper-stt carries raw microphone audio and local-tts carries
   * what the assistant says, so "whoever got to the port first" is not an
   * acceptable answer for either.
   */
  verifyIdentity(ms: ManagedService): Promise<Result<undefined, DriverError>>;
  start(name: ServiceName): Promise<Result<undefined, DriverError>>;
  stop(name: ServiceName): Promise<Result<undefined, DriverError>>;
  remove(name: ServiceName): Promise<Result<undefined, DriverError>>;
  listManaged(): Promise<ManagedProcessInfo[]>;
}
