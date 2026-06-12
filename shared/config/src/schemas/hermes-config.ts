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

/**
 * ACP wire resilience — auto-reconnect tunables for the gateway→Hermes ACP
 * WebSocket. On an ABNORMAL close (e.g. 1006 after a gateway restart / resumed
 * session flap) the wire re-opens + re-runs `initialize` on the next dispatch,
 * bounded by these knobs. A clean teardown (1000 / session end) never
 * reconnects. open_timeout_ms bounds each open handshake.
 */
export const hermesAcpWireSchema = z
  .object({
    open_timeout_ms: z.number().int().min(500).max(60_000).default(5_000),
    reconnect_base_ms: z.number().int().min(50).max(10_000).default(500),
    reconnect_max_ms: z.number().int().min(100).max(60_000).default(5_000),
    reconnect_jitter_ms: z.number().int().min(0).max(10_000).default(250),
    reconnect_max_attempts: z.number().int().min(1).max(20).default(5),
  })
  .default({});
export type HermesAcpWire = z.infer<typeof hermesAcpWireSchema>;

/** Full hermes: section of gateway config. */
export const hermesConfigSchema = z.object({
  worker: hermesWorkerSchema,
  acp_wire: hermesAcpWireSchema,
  defaults: z
    .object({
      max_output_tokens: z.number().int().default(512),
    })
    .default({}),
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
