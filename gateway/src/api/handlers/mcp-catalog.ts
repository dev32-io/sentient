import type { HermesBuiltinTools, McpCatalog, ToolPermission, ToolPermissionMap } from "@sentient/config";
import { type ImpactTier, type UserRole, canExecute } from "@sentient/protocol";
import { getLog } from "../../logging/logger.js";
import type { ProfileStore } from "../../profile-store/profile-store.js";
import { delegateTaskDefinition } from "../../tools/delegate-task.js";
import { resolveToolPermission } from "../../tools/resolve-tool-permission.js";
import { defaultPermissionsFor } from "../../tools/role-defaults.js";
import { createToolPermissionsReader } from "../../tools/user-tool-permissions.js";
import type { TokenService } from "../../user-auth/token-service.js";
import type { UserStore } from "../../user-auth/user-store.js";

const log = getLog(["sentient", "gateway", "api", "mcp-catalog"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_METHOD = 405;
const HTTP_INTERNAL = 500;

const PATH = "/api/v1/mcp-catalog";

/** Short, HUMAN-facing copy for `delegateTask` in the settings screen —
 *  deliberately separate from `delegateTaskDefinition.description`, which is
 *  written for the MODEL (a multi-paragraph usage prompt: when to reach for
 *  delegation and when not to). Reusing that verbatim here would dump a
 *  system-prompt wall of text into a settings row next to one-line catalog
 *  descriptions. */
const DELEGATE_TASK_SETTINGS_DESCRIPTION =
  "Hand a task to a background worker agent (Hermes) with its own tools and workspace. Runs unsupervised until it finishes.";

// What we expose to the webui for the per-tool permission UI. The catalog
// also carries transport details (url/command/env/api keys) — those are
// operator concerns and stay server-side. The UI needs, per tool: its name,
// description, IMPACT TIER (who may ever reach it — `canExecute(role, tier)`)
// and this PERSON's resolved PERMISSION (what happens when they do). Both
// fields come from the SAME resolver the ToolBroker's PDP dispatches through
// (`tools/resolve-tool-permission.ts`, plan 2026-08-07-tool-permissions task
// 5) — a settings screen that could disagree with the broker about the same
// tool would be lying about what the model can do.
//
// NO `inherited` flag, no tri-state. Every tool carries exactly one concrete
// `allow | ask | deny | off` — that is the whole point of the role-template
// floor Task 4 shipped: absence is well-defined, so there is nothing left to
// spell as "inherited".
export interface McpToolView {
  readonly name: string;
  readonly description: string;
  readonly tier: ImpactTier;
  readonly permission: ToolPermission;
}

export interface McpCatalogEntryView {
  /** Operator-declared universe (name + description per tool), narrowed to
   *  what THIS PERSON'S ROLE may ever execute — a tool a child's role can
   *  never reach is omitted entirely rather than shown locked: a row nobody
   *  in this account can ever change is noise, not information. A tool the
   *  role CAN reach is always listed, even when its resolved `permission` is
   *  `off` — that is a real, person-editable state, not a locked one. */
  readonly tools: readonly McpToolView[];
  /** Operator-curated default whitelist (subset of `tools` names). Predates
   *  per-tool permissions (`tools.enabled`'s narrowing-array format) — kept
   *  for existing consumers; superseded for governance purposes by each
   *  tool's own `permission` above. */
  readonly defaultInclude: readonly string[];
  readonly description?: string;
}

export interface HermesBuiltinToolView {
  readonly name: string;
  readonly description: string;
  /** The Hermes toolset this tool lives inside. Enabling any tool of a
   *  toolset enables the whole toolset on the agent — the webui shows
   *  per-tool toggles but stores the choice as a toolset on/off in
   *  `profile.tools.toolsets`. */
  readonly toolset: string;
}

export interface McpCatalogView {
  readonly servers: Record<string, McpCatalogEntryView>;
  /** Gateway-native tools with no MCP server — today just `delegateTask`
   *  (`tools/delegate-task.ts`). No `mcp_catalog` entry curates it (it is
   *  gateway-native, not catalog-keyed), so it cannot live under `servers`;
   *  it is governed by the SAME resolver and the SAME role gate as every
   *  catalog tool, just addressed by declared tier instead of by server.
   *  Empty for a role that cannot reach `confirm` (child, guest). */
  readonly nativeTools: readonly McpToolView[];
  /** Per-tool descriptors for Hermes built-in tools — drives the
   *  "Hermes built-ins" UI category. */
  readonly hermesBuiltins: readonly HermesBuiltinToolView[];
}

export interface McpCatalogHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  catalog: McpCatalog;
  hermesBuiltinTools: HermesBuiltinTools;
  /** The account's ROLE, read from its record at the moment of THIS request —
   *  never from a token claim, never cached (mirrors `tool-broker.ts`'s own
   *  rule). The role gates which tools this projection may ever show. */
  users: Pick<UserStore, "get">;
  /** Source of this person's OWN stored `profile.tools.permissions`, read
   *  fresh per request through the same fail-closed reader the ToolBroker
   *  uses (`tools/user-tool-permissions.ts`) — so a settings read and a live
   *  dispatch degrade the same way on an unreadable profile. */
  profileStore: ProfileStore;
}

export function createMcpCatalogHandler(deps: McpCatalogHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: HTTP_METHOD });
    }
    const url = new URL(request.url);
    if (url.pathname !== PATH) {
      return new Response("Not Found", { status: 404 });
    }
    const auth = await authorize(deps, request);
    if (!auth.ok) return auth.response;

    const roleResult = await resolveRole(deps, auth.userId);
    if (!roleResult.ok) return roleResult.response;
    const { role } = roleResult;

    const roleTemplate = defaultPermissionsFor(role, deps.catalog);
    const storedPermissions = await createToolPermissionsReader({
      profileStore: deps.profileStore,
      userId: auth.userId,
    })();

    const view: McpCatalogView = {
      servers: projectServers(deps.catalog, role, roleTemplate, storedPermissions),
      nativeTools: projectNativeTools(role, roleTemplate, storedPermissions),
      hermesBuiltins: deps.hermesBuiltinTools.map((t) => ({
        name: t.name,
        description: t.description,
        toolset: t.toolset,
      })),
    };
    log.info("mcp-catalog.list", {
      userId: auth.userId,
      role,
      serverCount: Object.keys(view.servers).length,
      nativeToolCount: view.nativeTools.length,
      hermesBuiltinCount: view.hermesBuiltins.length,
    });
    return Response.json(view, { status: HTTP_OK });
  };
}

/**
 * Per-server tool projection, narrowed to what `role` may ever reach and
 * resolved through the SAME rule the ToolBroker's PDP dispatches through.
 *
 * STDIO SERVERS ARE EXCLUDED ENTIRELY (decision, plan 2026-08-07-tool-
 * permissions task 5). `mcp-client.ts`'s `httpEntry` skips any `stdio`
 * catalog entry when dialing out for the gateway's own ReAct loop, and
 * `mcp-host/delegated-broker.ts`'s proxied-call broker dials the SAME
 * http-only client — so the one stdio entry this catalog ships today
 * (`gateway:`, `mcp-host/tools/*`) is reachable ONLY by a delegated worker's
 * direct socket connection (`mcp-host/mcp-server.ts`), which is gated
 * SOLELY by impact tier (`external-tools/delegated-tool-tier.ts`) and never
 * consults this person's permission table at all. Projecting a per-tool
 * dropdown for it would show a lever that changes nothing when pulled —
 * worse than the role-locked row this same function omits above, because
 * that one is at least honest about being inert. Generalized on `transport`
 * rather than by server name, so a future stdio entry inherits the same
 * exclusion without a second decision.
 */
function projectServers(
  catalog: McpCatalog,
  role: UserRole,
  roleTemplate: ToolPermissionMap,
  storedPermissions: ToolPermissionMap | undefined,
): Record<string, McpCatalogEntryView> {
  const out: Record<string, McpCatalogEntryView> = {};
  for (const [serverName, entry] of Object.entries(catalog)) {
    if (entry.transport === "stdio") continue;

    const universe = entry.tools.available ?? entry.tools.include;
    const tools: McpToolView[] = [];
    for (const tool of universe) {
      if (!canExecute(role, tool.tier)) continue;
      const { permission } = resolveToolPermission({
        toolName: tool.name,
        tier: tool.tier,
        serverName,
        storedPermissions,
        roleTemplate,
      });
      tools.push({ name: tool.name, description: tool.description, tier: tool.tier, permission });
    }
    // Nothing left for this role to govern on this server — an empty,
    // expandable section is the same noise a locked row is.
    if (tools.length === 0) continue;

    const defaultInclude: readonly string[] = entry.tools.include.map((t) => t.name);
    out[serverName] = entry.description
      ? { tools, defaultInclude, description: entry.description }
      : { tools, defaultInclude };
  }
  return out;
}

/**
 * `delegateTask` (decision, plan 2026-08-07-tool-permissions task 5): IT DOES
 * appear in the projection. It is a real tool with a real, always-enforced
 * resolved permission — the role gate and the tier→permission mapping both
 * apply to it on every dispatch exactly as they do to a catalog tool
 * (`tool-broker.ts`'s `resolvePermission`, serverless branch) — and it is the
 * one tool that spawns an unsupervised agent run, which is precisely the kind
 * of thing a person should be able to SEE is governed. What it cannot do yet
 * is be OVERRIDDEN: `serverOf("delegateTask")` is `null` structurally (no MCP
 * server addresses it), so `storedPermissionFor` can never answer for it no
 * matter what a client writes back — every account's `delegateTask` permission
 * is, and will remain, exactly its role template's answer for `confirm` until
 * a later task gives it a storable key. Reporting an accurate value the
 * settings screen cannot yet let a person CHANGE is still honest; inventing a
 * writable-looking slot for it here would not be.
 */
function projectNativeTools(
  role: UserRole,
  roleTemplate: ToolPermissionMap,
  storedPermissions: ToolPermissionMap | undefined,
): McpToolView[] {
  const { name, tier } = delegateTaskDefinition;
  if (!canExecute(role, tier)) return [];
  const { permission } = resolveToolPermission({
    toolName: name,
    tier,
    serverName: null,
    storedPermissions,
    roleTemplate,
  });
  return [{ name, description: DELEGATE_TASK_SETTINGS_DESCRIPTION, tier, permission }];
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
