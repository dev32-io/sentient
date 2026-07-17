import { readFile } from "node:fs/promises";
import { type YAMLMap, isMap, parseDocument } from "yaml";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "profile-store", "preserve-agent-sections"]);

// ---------------------------------------------------------------------------
// Keys under `agent:` that live ONLY in the rendered config.yaml — written by
// personality-store.ts via the yaml Document API, NOT carried in profile.json /
// ProfileV1. The profile-renderer regenerates config.yaml from the profile, so
// without preserving these an apply / boot re-render wipes the whole personality
// library (agent.personalities) plus the active personality (agent.system_prompt).
// ---------------------------------------------------------------------------

const PRESERVED_AGENT_KEYS = ["personalities", "system_prompt"] as const;

/**
 * Splice the personality-owned `agent.personalities` + `agent.system_prompt`
 * from the existing on-disk config.yaml into a freshly rendered config.yaml.
 *
 * Pure: returns the merged YAML string. Best-effort — if either document fails
 * to parse or has no `agent:` map, the rendered YAML is returned unchanged
 * (a broken existing file must never corrupt the fresh render).
 */
export function preserveAgentSections(renderedYaml: string, existingYaml: string): string {
  const existingAgent = readAgentMap(existingYaml, "existing");
  if (!existingAgent) return renderedYaml;

  const renderedDoc = parseDocument(renderedYaml);
  const renderedAgent = renderedDoc.errors.length === 0 ? renderedDoc.get("agent") : undefined;
  if (!isMap(renderedAgent)) {
    log.warn("preserve.no-rendered-agent", { reason: "rendered config has no agent map" });
    return renderedYaml;
  }

  let preserved = 0;
  for (const key of PRESERVED_AGENT_KEYS) {
    // keepScalar=true keeps the original node (block scalar formatting, nested
    // map shape) so multi-line personality bodies round-trip unchanged.
    const node = existingAgent.get(key, true);
    if (node === undefined || node === null) continue;
    renderedAgent.set(key, node);
    preserved++;
  }
  if (preserved === 0) return renderedYaml;

  log.debug("preserve.merged", { keys: preserved });
  return renderedDoc.toString();
}

/**
 * Read the existing config.yaml (if any) and merge its preserved agent sections
 * into `renderedYaml`. When no prior file exists (first provision) the rendered
 * YAML is returned as-is.
 */
export async function mergePreservedConfig(configPath: string, renderedYaml: string): Promise<string> {
  let existing: string;
  try {
    existing = await readFile(configPath, "utf8");
  } catch {
    return renderedYaml;
  }
  return preserveAgentSections(renderedYaml, existing);
}

function readAgentMap(yaml: string, which: string): YAMLMap | null {
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) {
    log.warn("preserve.parse-error", { which, count: doc.errors.length });
    return null;
  }
  const agent = doc.get("agent");
  return isMap(agent) ? agent : null;
}
