import { isDeepStrictEqual } from "node:util";
import { ALL_TOOLS_PERMISSION_KEY, NATIVE_TOOL_SERVER_KEY, productToolGroupSchema, toolPermissionSchema, type ToolPermissionMap } from "../../shared/config/src/index.ts";
import { z } from "zod";
import { foundationProductToolMetadata } from "../../gateway/src/bootstrap/product-tool-metadata.ts";
import { delegateTaskDefinition } from "../../gateway/src/tools/delegate-task.ts";
import type { ProfileV1 } from "../../gateway/src/profile-store/profile-types.ts";

// Foundation registry is not the whole native surface: settings also projects
// skills, memory and delegation. Legacy metadata-less runners use native.
export const textOnlyRequiredGroups = [...new Set([
  ...foundationProductToolMetadata().map(tool => tool.productGroup),
  "skills", "memory", delegateTaskDefinition.productGroup ?? NATIVE_TOOL_SERVER_KEY,
])];

export const fixtureToolCatalogSchema = z.object({
  wildcardPermissionKey: z.literal(ALL_TOOLS_PERMISSION_KEY),
  groups: z.record(productToolGroupSchema, z.object({
    tools: z.array(z.object({ permission: toolPermissionSchema })),
    wildcardPermission: toolPermissionSchema.nullable(),
  })),
});

export function textOnlyFixtureTools(rawCatalog: unknown): ProfileV1["tools"] {
  const catalog = fixtureToolCatalogSchema.parse(rawCatalog);
  if (textOnlyRequiredGroups.some(group => !Object.hasOwn(catalog.groups, group))) {
    throw new Error("text-only fixture catalog is missing a current native product group");
  }
  const permissions: ToolPermissionMap = Object.fromEntries(
    [...new Set([NATIVE_TOOL_SERVER_KEY, ...Object.keys(catalog.groups)])]
      .map(group => [group, { [ALL_TOOLS_PERMISSION_KEY]: "off" }]),
  );
  return { permissions, toolsets: [] };
}

export function assertTextOnlyFixtureTools(actual: ProfileV1["tools"], expected: ProfileV1["tools"]): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error("text-only fixture tools differ from exact deny-all contract");
}
