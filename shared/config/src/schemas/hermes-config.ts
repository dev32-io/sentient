import { z } from "zod";

// ---------------------------------------------------------------------------
// Hermes Agent integration config — per spec v4 §5, §7, §9
// ---------------------------------------------------------------------------

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
  /** Base path for the gateway's per-user MCP sockets; only its directory is
   *  used. The default anchors on `~` (expanded by `mcp-host/socket-path.ts`)
   *  because the state root is the only writable anchor that holds in a repo
   *  checkout AND in a compiled binary under launchd. It was
   *  `/run/sentient/mcp.sock` for the containerized Hermes — `/run` does not
   *  exist on a native macOS host, so every socket silently failed to open. */
  socket_path: z.string().default("~/.sentient/run/mcp.sock"),
});
export type HermesMcpHost = z.infer<typeof hermesMcpHostSchema>;

/** Full hermes: section of gateway config.
 *
 * Down to the two blocks with live readers. `worker:` (container_name /
 * url_template / port_base) addressed the per-user supervisord-managed Hermes
 * child inside the `sentient-hermes` container — no such process exists now
 * that Hermes is a one-shot exec, and nothing read those keys. `tts:`
 * (markdown/emoji stripping) had no reader either: the native orchestrator
 * streams provider deltas straight into local-tts. */
export const hermesConfigSchema = z.object({
  /** Read by `config/operator-config-migrator.ts` (the pre-0.1.0
   *  duckduckgo → searxng rewrite). */
  web_tools: hermesWebToolsSchema,
  /** Read by `bootstrap/create-mcp-host.ts` for the per-user socket base
   *  path — the gateway's own MCP server, which Hermes dials back into. */
  mcp_host: hermesMcpHostSchema.default({}),
});
export type HermesConfig = z.infer<typeof hermesConfigSchema>;
