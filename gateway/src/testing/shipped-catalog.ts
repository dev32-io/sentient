// TEST SUPPORT ONLY — nothing in the running gateway imports this. Production
// reads its catalog through `config/startup-config.ts`, which resolves the
// operator's own `~/.sentient/gateway/config.yaml`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type McpCatalog, loadConfig, mcpCatalogSchema } from "@sentient/config";
import { z } from "zod";

/**
 * The `mcp_catalog` this repo SHIPS, parsed through the real schema.
 *
 * Tests that seed a permission table use this rather than a fixture on purpose:
 * the failure being guarded against is "a genuinely fresh account came out with
 * no tools", and a stub catalog is just as green while the real one seeds
 * nothing. The relative path to `gateway/config.yaml` lives here once so three
 * test files cannot drift on it.
 */
export function loadShippedCatalog(): McpCatalog {
  return loadConfig(
    readFileSync(join(import.meta.dir, "../../config.yaml"), "utf-8"),
    z.object({ mcp_catalog: mcpCatalogSchema }),
  ).mcp_catalog;
}
