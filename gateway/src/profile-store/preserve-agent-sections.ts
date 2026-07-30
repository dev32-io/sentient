import { readFile } from "node:fs/promises";
import { type YAMLMap, isMap, parseDocument } from "yaml";
import { getLog } from "../logging/logger.js";
import { resolveBody } from "./personality-store.js";

const log = getLog(["sentient", "gateway", "profile-store", "preserve-agent-sections"]);

// ---------------------------------------------------------------------------
// Keys under `agent:` that live ONLY in the rendered config.yaml — written by
// personality-store.ts via the yaml Document API, NOT carried in profile.json /
// ProfileV1. The profile-renderer regenerates config.yaml from the profile, so
// without preserving these an apply / boot re-render wipes the whole personality
// library (agent.personalities) plus the active personality (agent.system_prompt).
// ---------------------------------------------------------------------------

const PERSONALITIES_KEY = "personalities";
const PRESERVED_AGENT_KEYS = [PERSONALITIES_KEY, "system_prompt"] as const;

/**
 * Drop personality entries whose body is empty, returning null when nothing
 * survives (so the caller omits the key rather than emitting an empty map).
 *
 * An empty body was harmless only while the rendered config.yaml was dead
 * output. Now that the gateway's MCP is registered on the delegated agent's
 * profile the file is live, and an empty body is a live BLANK system prompt —
 * plus `personality-store`'s `findActiveName` matches any such entry against an
 * empty `agent.system_prompt`, so the webui reports the wrong personality as
 * active. Both writers now reject an empty body; this repairs what older
 * builds already wrote, on the next boot re-render.
 */
function dropEmptyBodies(node: YAMLMap): YAMLMap | null {
  const kept = node.items.filter((item) => resolveBody(item.value).trim().length > 0);
  if (kept.length === 0) {
    log.info("preserve.dropped-personalities", {
      dropped: node.items.length,
      reason: "every personality body was empty; an empty body renders as a blank live system prompt",
    });
    return null;
  }
  if (kept.length === node.items.length) return node;
  log.info("preserve.dropped-personalities", {
    dropped: node.items.length - kept.length,
    kept: kept.length,
    reason: "empty personality body renders as a blank live system prompt",
  });
  const trimmed = node.clone() as YAMLMap;
  trimmed.items = kept;
  return trimmed;
}

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
    if (key === PERSONALITIES_KEY && isMap(node)) {
      const kept = dropEmptyBodies(node);
      if (kept === null) continue;
      renderedAgent.set(key, kept);
      preserved++;
      continue;
    }
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
