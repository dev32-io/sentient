import { readFileSync } from "node:fs";
import { type McpPolicy, loadConfig, mcpPolicySchema } from "@sentient/config";
import { assetPath } from "../config/asset-root.ts";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "security", "policy-loader"]);

/** Ships beside the other baked-in assets, so it moves with the asset root. */
const POLICY_FILENAME = "mcp-policy.yaml";

/** Load MCP policy from YAML. Falls back to empty rules on missing file.
 *  A *bogus asset root* is not a missing file — `assetPath` throws there, so a
 *  mis-deployed binary can never silently degrade to an empty rule set. */
export function loadMcpPolicy(filePath?: string): McpPolicy {
  const resolvedPath = filePath ?? assetPath(POLICY_FILENAME);
  try {
    const content = readFileSync(resolvedPath, "utf-8");
    return loadConfig(content, mcpPolicySchema);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("policy-loader.missing-file", { path: resolvedPath, err: msg });
    return { rules: [] };
  }
}
