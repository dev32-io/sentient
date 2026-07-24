import { z } from "zod";

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

export const hermesMcpHostSchema = z.object({
  transport: z.enum(["unix_socket", "http"]).default("unix_socket"),
  socket_path: z.string().default("/run/sentient/mcp.sock"),
});
export type HermesMcpHost = z.infer<typeof hermesMcpHostSchema>;

/** Full hermes: section of gateway config. */
export const hermesConfigSchema = z.object({
  worker: hermesWorkerSchema,
  web_tools: hermesWebToolsSchema,
  mcp_host: hermesMcpHostSchema.default({}),
  tts: z
    .object({
      markdown_stripping_enabled: z.boolean().default(true),
      emoji_stripping_enabled: z.boolean().default(true),
    })
    .default({}),
});
export type HermesConfig = z.infer<typeof hermesConfigSchema>;
