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

export const ManagedServiceConfigSchema = z.object({
  template: z.string().min(1),
  allowed_images: z.array(z.string().min(1)).nonempty(),
  networks: z.array(z.string().min(1)).nonempty(),
  secrets: z.record(z.string(), z.string()).optional().default({}),
  healthcheck: HealthCheckSchema,
  depends_on: z.array(ServiceNameSchema).optional().default([]),
  optional: z.boolean().optional().default(false),
});
export type ManagedServiceConfig = z.infer<typeof ManagedServiceConfigSchema>;

/** Parsed YAML template body. The orchestrator forbids `ports`. Any volume
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
  // The presence of `ports` (host port mapping) is a policy violation.
  ports: z.never().optional(),
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

export type ManagedService = {
  name: ServiceName;
  config: ManagedServiceConfig;
  template: ServiceTemplate;
};
