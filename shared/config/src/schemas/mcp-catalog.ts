import { z } from "zod";

// ---------------------------------------------------------------------------
// MCP Catalog — operator-managed inventory of available MCP servers
// ---------------------------------------------------------------------------
// One entry per MCP that may be exposed to a user's Hermes worker. The
// per-user `profile.tools.enabled[]` list carries names that reference into
// this catalog; the renderer joins entry + slotKey/userId at render time.
//
// New MCPs are added by editing this YAML — no code change, no rebuild.
// User-facing toggle UI fetches the catalog and offers each entry as an
// on/off switch.
//
// Variable interpolation (rendered into command/args/url/env values):
//   {{userId}}   real auth-derived user id (e.g. u_6ae26974)
//   {{slotKey}}  Hermes profile id (= MCP socket basename for the
//                gateway-hosted server; matches hermes.profiles[*] keys)

// One tool the MCP exposes. `available` is the operator-declared universe
// (full list) for the webui to render with descriptions. `include` /
// `exclude` are operator-curated whitelist / blacklist over those names.
const mcpToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
});
export type McpToolDescriptor = z.output<typeof mcpToolDescriptorSchema>;

const mcpToolFilterSchema = z.object({
  available: z.array(mcpToolDescriptorSchema).optional(),
  include: z.array(z.string()).min(1).optional(),
  exclude: z.array(z.string()).min(1).optional(),
  // Hermes-side knobs (per-MCP) that toggle the four "housekeeping" tools
  // it auto-registers for every MCP regardless of include/exclude:
  //   list_resources, read_resource, list_prompts, get_prompt
  // Each one adds tool-definition tokens to every cycle prompt prefix and
  // is never useful for our voice flows (the resources/prompts surface
  // is editor-IDE territory). Default false in our config.yaml — set true
  // per-server only if a workflow actually needs MCP resources/prompts.
  resources: z.boolean().optional(),
  prompts: z.boolean().optional(),
});
export type McpToolFilter = z.output<typeof mcpToolFilterSchema>;

const mcpHttpEntrySchema = z.object({
  transport: z.literal("http"),
  url: z.string().min(1),
  timeout: z.number().int().min(1).max(600).default(30),
  connect_timeout: z.number().int().min(1).max(60).default(5),
  description: z.string().optional(),
  tools: mcpToolFilterSchema.optional(),
});

const mcpStdioEntrySchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  timeout: z.number().int().min(1).max(600).default(30),
  connect_timeout: z.number().int().min(1).max(60).default(10),
  description: z.string().optional(),
  tools: mcpToolFilterSchema.optional(),
});

export const mcpServerEntrySchema = z.discriminatedUnion("transport", [mcpHttpEntrySchema, mcpStdioEntrySchema]);
export type McpServerEntry = z.output<typeof mcpServerEntrySchema>;

export const mcpCatalogSchema = z.record(z.string(), mcpServerEntrySchema).default({});
export type McpCatalog = z.output<typeof mcpCatalogSchema>;
