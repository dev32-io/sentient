import { z } from "zod";
import { satelliteDevicesSchema } from "./satellite-devices.js";

// ---------------------------------------------------------------------------
// Hermes Agent integration config — per spec v4 §5, §7, §9
// ---------------------------------------------------------------------------

/**
 * Worker template — single source of truth for how the gateway dials any
 * supervisord-managed Hermes child. Each user gets a unique port allocated
 * at user-create time (port_base + idx, monotonic, unbounded). Userland
 * URL = url_template with {port} substituted.
 *
 * Replaces the legacy `profiles: { alice|bob|family: {...} }` block — that
 * shape forced operator-named slots and capped concurrent users at the
 * number of YAML entries. The template form addresses workers by userId
 * everywhere; the user-port-store maps userId → port.
 */
export const hermesWorkerSchema = z.object({
  container_name: z.string().min(1),
  url_template: z
    .string()
    .min(1)
    .refine((v) => v.includes("{port}"), { message: "url_template must contain {port}" }),
  port_base: z.number().int().min(1024).max(65535).default(8650),
});
export type HermesWorker = z.infer<typeof hermesWorkerSchema>;

export const hermesResourceManagementSchema = z.object({
  mode: z.enum(["always_on", "on_demand"]).default("always_on"),
  max_concurrent: z.number().int().min(1).default(3),
  idle_pause_after_ms: z.number().int().default(900_000),
  idle_stop_after_ms: z.number().int().default(3_600_000),
  ram_pressure_threshold_pct: z.number().min(0).max(100).default(85),
  cold_start_filler_text: z.string().default("one sec..."),
});
export type HermesResourceManagement = z.infer<typeof hermesResourceManagementSchema>;

export const hermesWebToolsSchema = z
  .object({
    provider: z.enum(["searxng"]).default("searxng"),
    searxng: z
      .object({
        enabled: z.boolean().default(true),
        url: z.string().url().optional(),
      })
      .default({}),
    voice_wrapper: z
      .object({
        enabled: z.boolean().default(false),
      })
      .default({}),
  })
  .default({});
export type HermesWebTools = z.infer<typeof hermesWebToolsSchema>;

export const hermesHomeAssistantObserverSchema = z
  .object({
    enabled: z.boolean().default(true),
    url: z.string().url().optional(),
    token_env: z.string().default("HA_OBSERVE_TOKEN"),
    watch_domains: z
      .array(z.string())
      .default(["binary_sensor", "climate", "alarm_control_panel", "light", "lock", "cover"]),
    watch_entities: z.array(z.string()).default([]),
    ignore_entities: z.array(z.string()).default([]),
    duplicate_state_window_ms: z.number().int().default(10_000),
  })
  .default({});
export type HermesHomeAssistantObserver = z.infer<typeof hermesHomeAssistantObserverSchema>;

export const hermesMcpHostSchema = z.object({
  transport: z.enum(["unix_socket", "http"]).default("unix_socket"),
  socket_path: z.string().default("/run/sentient/mcp.sock"),
});
export type HermesMcpHost = z.infer<typeof hermesMcpHostSchema>;

export const hermesAmbientSchema = z
  .object({
    event_log: z
      .object({
        enabled: z.boolean().default(true),
        retention_count: z.number().int().default(10_000),
        persist_path: z.string().default("./data/ambient-events.db"),
      })
      .default({}),
    dispatch: z
      .object({
        steward_enabled: z.boolean().default(false), // v1.5+
        accumulation_window_ms: z.number().int().default(2000),
      })
      .default({}),
  })
  .default({});
export type HermesAmbient = z.infer<typeof hermesAmbientSchema>;

/** Full hermes: section of gateway config. */
export const hermesConfigSchema = z.object({
  worker: hermesWorkerSchema,
  defaults: z
    .object({
      max_output_tokens: z.number().int().default(512),
      request_timeout_ms: z.number().int().default(60_000),
      idempotency_window_s: z.number().int().default(300),
    })
    .default({}),
  resource_management: hermesResourceManagementSchema.default({}),
  web_tools: hermesWebToolsSchema,
  home_assistant_observer: hermesHomeAssistantObserverSchema,
  mcp_host: hermesMcpHostSchema.default({}),
  ambient: hermesAmbientSchema,
  satellite_devices: satelliteDevicesSchema,
  tts: z
    .object({
      markdown_stripping_enabled: z.boolean().default(true),
      emoji_stripping_enabled: z.boolean().default(true),
    })
    .default({}),
});
export type HermesConfig = z.infer<typeof hermesConfigSchema>;
