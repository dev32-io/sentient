import type { HermesBuiltinTools, McpCatalog } from "@sentient/config";
import { getLog } from "../../logging/logger.js";
import type { TokenService } from "../../user-auth/token-service.js";

const log = getLog(["sentient", "gateway", "api", "mcp-catalog"]);

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_METHOD = 405;

const PATH = "/api/v1/mcp-catalog";

// What we expose to the webui for the per-tool toggle UI. The catalog
// also carries transport details (url/command/env/api keys) — those are
// operator concerns and stay server-side. The UI only needs: per server
// the universe (`tools` = name+description), the operator-curated
// default (`include` = whitelist subset), and a separate Hermes built-in
// category with per-tool toolset binding for the "Hermes built-ins" UI
// row group.
export interface McpToolView {
  readonly name: string;
  readonly description: string;
}

export interface McpCatalogEntryView {
  /** Operator-declared universe (name + description per tool). The
   *  webui renders one row per entry — toggled-on rows resolve against
   *  `defaultInclude` and the user's per-server narrowing. */
  readonly tools: readonly McpToolView[];
  /** Operator-curated default whitelist (subset of `tools` names).
   *  Used as the inherited baseline when a user's profile has an empty
   *  per-server list. */
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
  /** Per-tool descriptors for Hermes built-in tools — drives the
   *  "Hermes built-ins" UI category. */
  readonly hermesBuiltins: readonly HermesBuiltinToolView[];
}

export interface McpCatalogHandlerDeps {
  tokens: Pick<TokenService, "validate">;
  catalog: McpCatalog;
  hermesBuiltinTools: HermesBuiltinTools;
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

    const view: McpCatalogView = {
      servers: project(deps.catalog),
      hermesBuiltins: deps.hermesBuiltinTools.map((t) => ({
        name: t.name,
        description: t.description,
        toolset: t.toolset,
      })),
    };
    log.info("mcp-catalog.list", {
      userId: auth.userId,
      serverCount: Object.keys(view.servers).length,
      hermesBuiltinCount: view.hermesBuiltins.length,
    });
    return Response.json(view, { status: HTTP_OK });
  };
}

function project(catalog: McpCatalog): Record<string, McpCatalogEntryView> {
  const out: Record<string, McpCatalogEntryView> = {};
  for (const [name, entry] of Object.entries(catalog)) {
    // `available` is the operator-declared universe (name + description per
    // tool). Fall back to projecting `include` when `available` is missing —
    // gives older operator configs a degraded but still-functional UI.
    const tools: McpToolView[] = entry.tools?.available
      ? entry.tools.available.map((t) => ({ name: t.name, description: t.description }))
      : (entry.tools?.include ?? []).map((n) => ({ name: n, description: "" }));
    const defaultInclude: readonly string[] = entry.tools?.include ?? tools.map((t) => t.name);
    const view: McpCatalogEntryView = entry.description
      ? { tools, defaultInclude, description: entry.description }
      : { tools, defaultInclude };
    out[name] = view;
  }
  return out;
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

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}
