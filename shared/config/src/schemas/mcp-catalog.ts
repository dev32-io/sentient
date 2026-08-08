import { type ImpactTier, impactTierSchema } from "@sentient/protocol";
import { z } from "zod";

// ---------------------------------------------------------------------------
// MCP Catalog — operator-managed inventory of available MCP servers
// ---------------------------------------------------------------------------
// One entry per MCP that may be exposed to the agent loop. THE enumeration of
// the tool universe: which tools exist, and what impact tier each carries.
// A person's profile addresses these by server + tool name in
// `tools.permissions`; the retired `profile.tools.enabled[]` name list is gone.
//
// New MCPs are added by editing this YAML — no code change, no rebuild.
//
// The user-facing Tools page is NOT an on/off switch per entry. Each tool gets
// its own four-state permission (`allow` / `ask` / `deny` / `off`), and a
// server's header control is a BULK write over those — never a fifth state of
// its own. See shared/config/src/schemas/tool-permission.ts.
//
// Variable interpolation (rendered into command/args/url/env values):
//   {{userId}}   real auth-derived user id (e.g. u_6ae26974)
//   {{slotKey}}  Hermes profile id (= MCP socket basename for the
//                gateway-hosted server; matches hermes.profiles[*] keys)

// One tool the MCP exposes. `available` is the operator-declared universe
// (full list) for the webui to render with descriptions. `include` /
// `exclude` are operator-curated whitelist / blacklist over those names.
//
// EVERY declared tool carries a `tier` — its IMPACT TIER, the input to the
// role gate (`canExecute(role, tier)` in @sentient/protocol). The tier says
// WHO may reach the tool at all; what happens when they do is the person's
// per-tool permission, which is a different table.
//
//   read    — answers a question, or acts only on the CALLER'S OWN session.
//             Anyone: admin, adult, child, guest.
//   write   — a routine, reversible change to HOUSEHOLD state (add a shopping
//             item, group two speakers). admin, adult, child.
//   confirm — irreversible, reaches outside the house, spends, or touches a
//             security-relevant device class. admin, adult.
//   admin   — operator-level control of the system itself. The `admin` ROLE
//             ONLY — an ordinary household adult does NOT reach it, which is
//             the whole reason the tier exists. No shipped tool carries it
//             today.
//
// `admin` is a ROLE, not a flag beside one. `ROLE_PERMISSIONS` in
// @sentient/protocol is the authority for the four lines above; this comment
// is the copy an operator reads before assigning a tier, so it must not drift
// from it.
//
// Tiering governs tools that reach THE HOUSEHOLD. It does not police a
// person's own session: every tool the gateway hosts in-process resolves the
// caller's own session and acts only on that, so all of those are `read` — see
// the `gateway:` entry in config.yaml, which states the rule once rather than
// re-deciding it per tool.
//
// There is NO default. An operator who adds a tool without a tier gets a
// config-load failure naming it (see `tieredToolSchema` below), because the
// two ways of guessing are both wrong in a way nobody notices: guess `read`
// and a guest gets a tool nobody meant to give them; guess `admin` and an
// adult silently loses one.
export interface McpToolDescriptor {
  name: string;
  description: string;
  tier: ImpactTier;
}

const rawToolDescriptorSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  tier: impactTierSchema.optional(),
});

/** Refuses an untiered tool BY NAME — a bare `tier: Required` zod path names
 *  an array index, and an operator staring at `include[7]` has to count. */
const tieredToolSchema = rawToolDescriptorSchema.transform((tool, ctx): McpToolDescriptor => {
  if (tool.tier === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tier"],
      fatal: true,
      message: `MCP tool "${tool.name}" declares no impact tier — add \`tier: read|write|confirm|admin\` to its mcp_catalog entry`,
    });
    return z.NEVER;
  }
  return { name: tool.name, description: tool.description, tier: tool.tier };
});

const mcpToolFilterSchema = z.object({
  available: z.array(tieredToolSchema).optional(),
  // REQUIRED, and the reason is the tier above: a server whose surface is
  // "whatever upstream advertises today" cannot be tiered, and an untiered
  // tool must not reach the model. Curating the list is what makes tiering
  // possible, so the two are one obligation.
  include: z.array(tieredToolSchema).min(1),
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
  // REQUIRED for the same reason `include` is (see above): a catalog entry
  // with no declared surface is a set of untiered tools.
  tools: mcpToolFilterSchema,
});

const mcpStdioEntrySchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  timeout: z.number().int().min(1).max(600).default(30),
  connect_timeout: z.number().int().min(1).max(60).default(10),
  description: z.string().optional(),
  // REQUIRED for the same reason `include` is (see above): a catalog entry
  // with no declared surface is a set of untiered tools.
  tools: mcpToolFilterSchema,
});

export const mcpServerEntrySchema = z.discriminatedUnion("transport", [mcpHttpEntrySchema, mcpStdioEntrySchema]);
export type McpServerEntry = z.output<typeof mcpServerEntrySchema>;

export const mcpCatalogSchema = z.record(z.string(), mcpServerEntrySchema).default({});
export type McpCatalog = z.output<typeof mcpCatalogSchema>;

/** One curated tool, joined to the server that exposes it. */
export interface CatalogTool extends McpToolDescriptor {
  server: string;
}

/** Every tool the operator curated, across every server, in catalog order.
 *  THE enumeration of the tool universe — the role gate, the per-role default
 *  permission table and the settings API all read the same list, so none of
 *  them can disagree about which tools exist or what tier one carries. */
export function catalogTools(catalog: McpCatalog): CatalogTool[] {
  return Object.entries(catalog).flatMap(([server, entry]) => entry.tools.include.map((tool) => ({ ...tool, server })));
}

/** The impact tier of one tool by name, or `undefined` when no catalog server
 *  curates it. `undefined` is NOT a tier and must never be widened into one:
 *  a caller that cannot find a tier is holding a tool the catalog does not
 *  describe, and the answer is to refuse it, not to pick a tier for it. */
export function tierOf(catalog: McpCatalog, toolName: string): ImpactTier | undefined {
  return catalogTools(catalog).find((tool) => tool.name === toolName)?.tier;
}
