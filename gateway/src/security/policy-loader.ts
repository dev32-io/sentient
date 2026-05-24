import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type McpPolicy, loadConfig, mcpPolicySchema } from "@sentient/config";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "security", "policy-loader"]);

const DEFAULT_POLICY_PATH = join(import.meta.dir, "../../mcp-policy.yaml");

/** Load MCP policy from YAML. Falls back to empty rules on missing file. */
export function loadMcpPolicy(filePath?: string): McpPolicy {
  const resolvedPath = filePath ?? DEFAULT_POLICY_PATH;
  try {
    const content = readFileSync(resolvedPath, "utf-8");
    return loadConfig(content, mcpPolicySchema);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("policy-loader.missing-file", { path: resolvedPath, err: msg });
    return { rules: [] };
  }
}
