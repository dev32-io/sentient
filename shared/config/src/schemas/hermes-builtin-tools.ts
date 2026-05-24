import { z } from "zod";

// ---------------------------------------------------------------------------
// Hermes built-in tools — operator-managed inventory for the webui Tools page
// ---------------------------------------------------------------------------
// Hermes (the agent runtime we drive over ACP) ships several built-in tool
// groups ("toolsets" in Hermes parlance). Each toolset bundles 1–N atomic
// tools. The renderer emits `agent.enabled_toolsets` into Hermes config so
// only the operator-selected toolsets are exposed to the model on each cycle.
//
// This catalog is the per-TOOL view: for each Hermes built-in tool we record
// its name, a one-line description (for the webui Tools page), and the
// `toolset` it belongs to. Per-tool toggles in the UI map back to a per-
// toolset enable/disable on `profile.tools.toolsets` (toolset is the smallest
// unit Hermes actually supports).
//
// Adding a new built-in tool here is a YAML edit + Hermes-version bump — no
// gateway code change required.

const hermesBuiltinToolEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  toolset: z.string().min(1),
});
export type HermesBuiltinToolEntry = z.output<typeof hermesBuiltinToolEntrySchema>;

export const hermesBuiltinToolsSchema = z.array(hermesBuiltinToolEntrySchema).default([]);
export type HermesBuiltinTools = z.output<typeof hermesBuiltinToolsSchema>;
