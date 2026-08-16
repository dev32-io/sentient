import { type McpCatalog, catalogTools } from "@sentient/config";
import { canExecute } from "@sentient/protocol";
import type { ProfileStore } from "../profile-store/profile-store.js";
import { resolveToolPermission } from "../tools/resolve-tool-permission.js";
import { defaultPermissionsFor } from "../tools/role-defaults.js";
import { createToolPermissionsReader } from "../tools/user-tool-permissions.js";
import type { UserStore } from "../user-auth/user-store.js";
import type { ToolDefinition } from "./mcp-protocol.js";
import type { ToolHandler } from "./mcp-server.js";

const PERMISSION_DENIED = "this gateway tool is not allowed for the delegated user";

export interface HostedToolSurface {
  refresh(): Promise<void>;
  definitions(): ToolDefinition[];
  handler(name: string): ToolHandler | null;
}

/** Per-user projection for gateway-hosted handlers. Catalog product metadata is
 * the authority for group/exposure/impact; the user's current profile and role
 * are re-read both for listing and immediately before execution. Delegation has
 * no prompt channel, so only an `allow` result is answerable. */
export function createHostedToolSurface(deps: {
  readonly userId: string;
  readonly handlers: readonly ToolHandler[];
  readonly catalog: McpCatalog;
  readonly profileStore: ProfileStore;
  readonly userStore: Pick<UserStore, "get">;
}): HostedToolSurface {
  const metadata = new Map(
    catalogTools(deps.catalog)
      .filter((tool) => tool.server === "gateway")
      .map((tool) => [tool.name, tool] as const),
  );
  const readPermissions = createToolPermissionsReader({ profileStore: deps.profileStore, userId: deps.userId });
  let advertised: ToolHandler[] = [];

  async function isAllowed(name: string): Promise<boolean> {
    const tool = metadata.get(name);
    if (!tool) return false;
    const user = await deps.userStore.get(deps.userId);
    if (!user.ok || user.value === null || !canExecute(user.value.role, tool.tier)) return false;
    const storedPermissions = await readPermissions();
    return (
      resolveToolPermission({
        toolName: tool.name,
        tier: tool.tier,
        productGroup: tool.productGroup,
        defaultExposure: tool.defaultExposure,
        storedPermissions,
        roleTemplate: defaultPermissionsFor(user.value.role, deps.catalog),
      }).permission === "allow"
    );
  }

  const wrapped = deps.handlers.map<ToolHandler>((handler) => ({
    def: handler.def,
    async run(args, ctx) {
      if (!(await isAllowed(handler.def.name))) {
        return { content: [{ type: "text", text: PERMISSION_DENIED }], isError: true };
      }
      return handler.run(args, ctx);
    },
  }));

  return {
    async refresh() {
      const allowed = await Promise.all(
        wrapped.map(async (handler) => ((await isAllowed(handler.def.name)) ? handler : null)),
      );
      advertised = allowed.filter((handler): handler is ToolHandler => handler !== null);
    },
    definitions: () => advertised.map((handler) => handler.def),
    handler: (name) => advertised.find((handler) => handler.def.name === name) ?? null,
  };
}
