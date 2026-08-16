import {
  ALL_TOOLS_PERMISSION_KEY,
  type HermesBuiltinTools,
  type McpCatalog,
  type ProductToolGroup,
  type ToolDefaultExposure,
  type ToolPermission,
  type ToolPermissionMap,
  catalogTools,
} from "@sentient/config";
import { type ImpactTier, type UserRole, canExecute } from "@sentient/protocol";
import { homeProductToolProvider } from "../../bootstrap/product-tools/home-provider.js";
import { getLog } from "../../logging/logger.js";
import type { ProfileStore } from "../../profile-store/profile-store.js";
import { delegateTaskDefinition } from "../../tools/delegate-task.js";
import { MEMORY_TOOL_SETTINGS } from "../../tools/memory-tools.js";
import { MUSIC_TOOL_SETTINGS } from "../../tools/music/music-tools.js";
import { resolveToolPermission } from "../../tools/resolve-tool-permission.js";
import { defaultPermissionsFor } from "../../tools/role-defaults.js";
import { SKILL_TOOL_SETTINGS } from "../../tools/skill-tools.js";
import { createToolPermissionsReader } from "../../tools/user-tool-permissions.js";
import type { TokenService } from "../../user-auth/token-service.js";
import type { UserStore } from "../../user-auth/user-store.js";

const log = getLog(["sentient", "gateway", "api", "mcp-catalog"]);
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_METHOD = 405;
const HTTP_INTERNAL = 500;
const PATH = "/api/v1/mcp-catalog";
const DELEGATE_TASK_SETTINGS_DESCRIPTION =
  "Hand a task to a background worker agent (Hermes) with its own tools and workspace.";
const HOME_SETTINGS_DESCRIPTION =
  "Read and control household devices, and manage scenes, automations, scripts, todo items, and calendar events. Removals require confirmation; raw code, files, and administration are not included.";

export interface ProductToolView {
  readonly name: string;
  readonly description: string;
  readonly tier: ImpactTier;
  readonly permission: ToolPermission;
  readonly settable: boolean;
  /** Retained for diagnostics only. Clients must never authorize or group by it. */
  readonly dispatch: { readonly kind: "mcp"; readonly serverName: string } | { readonly kind: "native" };
}

/** Backwards-compatible type name for consumers of the endpoint module. */
export type McpToolView = ProductToolView;

export interface ProductToolGroupView {
  readonly tools: readonly ProductToolView[];
  readonly wildcardPermission: ToolPermission | null;
  readonly defaultExposure: ToolDefaultExposure;
  readonly description?: string;
}

export interface McpCatalogView {
  /** Stable product sections. There is intentionally no server-shaped settings map. */
  readonly groups: Record<ProductToolGroup, ProductToolGroupView>;
  readonly wildcardPermissionKey: string;
  readonly hermesBuiltins: readonly HermesBuiltinToolView[];
}

export interface HermesBuiltinToolView {
  readonly name: string;
  readonly description: string;
  readonly toolset: string;
}

export interface McpCatalogHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  catalog: McpCatalog;
  hermesBuiltinTools: HermesBuiltinTools;
  users: Pick<UserStore, "get">;
  profileStore: ProfileStore;
}

export function createMcpCatalogHandler(deps: McpCatalogHandlerDeps): (request: Request) => Promise<Response> {
  const permissionReaders = new Map<string, () => Promise<ToolPermissionMap | undefined>>();
  function readerFor(userId: string): () => Promise<ToolPermissionMap | undefined> {
    const existing = permissionReaders.get(userId);
    if (existing) return existing;
    const reader = createToolPermissionsReader({ profileStore: deps.profileStore, userId });
    permissionReaders.set(userId, reader);
    return reader;
  }

  return async (request) => {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: HTTP_METHOD });
    if (new URL(request.url).pathname !== PATH) return new Response("Not Found", { status: 404 });
    const auth = await authorize(deps, request);
    if (!auth.ok) return auth.response;
    const roleResult = await resolveRole(deps, auth.userId);
    if (!roleResult.ok) return roleResult.response;

    const roleTemplate = defaultPermissionsFor(roleResult.role, deps.catalog);
    const storedPermissions = await readerFor(auth.userId)();
    const view: McpCatalogView = {
      groups: projectGroups(deps.catalog, roleResult.role, roleTemplate, storedPermissions),
      wildcardPermissionKey: ALL_TOOLS_PERMISSION_KEY,
      hermesBuiltins: deps.hermesBuiltinTools.map((t) => ({
        name: t.name,
        description: t.description,
        toolset: t.toolset,
      })),
    };
    log.info("mcp-catalog.list", {
      userId: auth.userId,
      role: roleResult.role,
      groupCount: Object.keys(view.groups).length,
      toolCount: Object.values(view.groups).reduce((n, group) => n + group.tools.length, 0),
    });
    return Response.json(view, { status: HTTP_OK });
  };
}

interface ProjectedTool {
  productGroup: ProductToolGroup;
  defaultExposure: ToolDefaultExposure;
  description?: string;
  tool: ProductToolView;
}

function projectGroups(
  catalog: McpCatalog,
  role: UserRole,
  roleTemplate: ToolPermissionMap,
  storedPermissions: ToolPermissionMap | undefined,
): Record<ProductToolGroup, ProductToolGroupView> {
  const projected: ProjectedTool[] = [];
  for (const meta of catalogTools(catalog)) {
    const entry = catalog[meta.server];
    if (!entry || entry.transport === "stdio" || !canExecute(role, meta.tier)) continue;
    const permission = resolveToolPermission({
      toolName: meta.name,
      tier: meta.tier,
      productGroup: meta.productGroup,
      defaultExposure: meta.defaultExposure,
      storedPermissions,
      roleTemplate,
    }).permission;
    projected.push({
      productGroup: meta.productGroup,
      defaultExposure: meta.defaultExposure,
      ...(entry.description ? { description: entry.description } : {}),
      tool: {
        name: meta.name,
        description: meta.description,
        tier: meta.tier,
        permission,
        settable: true,
        dispatch: { kind: "mcp", serverName: meta.server },
      },
    });
  }

  const addNative = (
    name: string,
    description: string,
    tier: ImpactTier,
    productGroup: ProductToolGroup,
    defaultExposure: ToolDefaultExposure,
    groupDescription?: string,
  ) => {
    if (!canExecute(role, tier)) return;
    const permission = resolveToolPermission({
      toolName: name,
      tier,
      productGroup,
      defaultExposure,
      storedPermissions,
      roleTemplate,
    }).permission;
    projected.push({
      productGroup,
      defaultExposure,
      ...(groupDescription ? { description: groupDescription } : {}),
      tool: { name, description, tier, permission, settable: true, dispatch: { kind: "native" } },
    });
  };
  for (const meta of SKILL_TOOL_SETTINGS) addNative(meta.name, meta.description, meta.tier, "skills", "standard");
  for (const meta of MEMORY_TOOL_SETTINGS) addNative(meta.name, meta.description, meta.tier, "memory", "standard");
  for (const meta of MUSIC_TOOL_SETTINGS) addNative(meta.name, meta.description, meta.tier, "music", "standard");
  for (const runner of homeProductToolProvider.create({}))
    addNative(
      runner.definition.name,
      runner.definition.description,
      runner.definition.tier,
      "home",
      "standard",
      HOME_SETTINGS_DESCRIPTION,
    );
  addNative(
    delegateTaskDefinition.name,
    DELEGATE_TASK_SETTINGS_DESCRIPTION,
    delegateTaskDefinition.tier,
    delegateTaskDefinition.productGroup ?? "delegation",
    delegateTaskDefinition.defaultExposure ?? "standard",
  );

  const groups: Record<string, ProductToolGroupView> = {};
  for (const item of projected) {
    const existing = groups[item.productGroup];
    if (existing && existing.defaultExposure !== item.defaultExposure) {
      // Configuration ambiguity must fail closed instead of allowing transport
      // ordering to choose whether a group is standard or advanced.
      log.warn("mcp-catalog.group-exposure-collision", { productGroup: item.productGroup, outcome: "off" });
      continue;
    }
    const tools = existing ? [...existing.tools, item.tool] : [item.tool];
    groups[item.productGroup] = {
      tools,
      wildcardPermission: storedPermissions?.[item.productGroup]?.[ALL_TOOLS_PERMISSION_KEY] ?? null,
      defaultExposure: item.defaultExposure,
      ...(existing?.description || item.description ? { description: existing?.description ?? item.description } : {}),
    };
  }
  return groups;
}

interface AuthOk {
  ok: true;
  userId: string;
}
interface AuthFail {
  ok: false;
  response: Response;
}

async function authorize(deps: McpCatalogHandlerDeps, request: Request): Promise<AuthOk | AuthFail> {
  const token = readBearer(request);
  if (!token) return { ok: false, response: Response.json({ error: "missing-token" }, { status: HTTP_UNAUTHORIZED }) };
  const valid = await deps.tokens.validate(token);
  if (!valid.ok) {
    return { ok: false, response: Response.json({ error: valid.error }, { status: HTTP_UNAUTHORIZED }) };
  }
  return { ok: true, userId: valid.value.userId };
}

interface RoleOk {
  ok: true;
  role: UserRole;
}
interface RoleFail {
  ok: false;
  response: Response;
}

/** The account's role, resolved fresh from its record. Fails CLOSED with a
 *  500 rather than defaulting to any role: the role is the input to every
 *  gate below it, and guessing one (permissive OR restrictive) would mean
 *  this endpoint sometimes answers for an account it never actually read. */
async function resolveRole(deps: McpCatalogHandlerDeps, userId: string): Promise<RoleOk | RoleFail> {
  const record = await deps.users.get(userId);
  if (!record.ok || record.value === null) {
    log.warn("mcp-catalog.role-unavailable", {
      userId,
      reason: record.ok ? "no-user-record" : record.error,
      outcome: "refused",
      detail: "the account's role gates every tool below it; a projection built without it would be a guess",
    });
    return { ok: false, response: Response.json({ error: "role-unavailable" }, { status: HTTP_INTERNAL }) };
  }
  return { ok: true, role: record.value.role };
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}
