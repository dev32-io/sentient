import { type HermesConfig, type McpCatalog, type OrchestratorConfig, tierOf } from "@sentient/config";
import type { ImpactTier } from "@sentient/protocol";
import type { AccessManager } from "../access/access-manager.js";
import { selectDelegatedTools } from "../external-tools/delegated-tool-tier.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { ActiveSessionLookup } from "../mcp-host/active-session-lookup.js";
import { createDelegatedBrokerFactory } from "../mcp-host/delegated-broker.js";
import { type HostedToolSurface, createHostedToolSurface } from "../mcp-host/hosted-tool-surface.js";
import type { McpServerDeps, ToolHandler, ToolRegistry } from "../mcp-host/mcp-server.js";
import { type NativeToolSurface, createNativeToolSurface } from "../mcp-host/native-tool-surface.js";
import { type ProxiedToolSurface, createProxiedToolSurface } from "../mcp-host/proxied-tool-surface.js";
import { resolveMcpSocketPath } from "../mcp-host/socket-path.js";
import type { AudioControls } from "../mcp-host/tools/audio-tools.js";
import { createPauseAudioTool, createResumeAudioTool } from "../mcp-host/tools/audio-tools.js";
import { createIdentifyUserTool } from "../mcp-host/tools/identify-user.js";
import { type UserSettingsControls, createUpdateUserSettingsTool } from "../mcp-host/tools/update-user-settings.js";
import { type UnixSocketListener, createUnixSocketListener } from "../mcp-host/unix-socket-listener.js";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { McpClient } from "../tools/mcp-client.js";
import type { NativeToolRunner } from "../tools/tool-broker.js";
import type { UserStore } from "../user-auth/user-store.js";

const log = getLog(["sentient", "bootstrap", "mcp-host"]);

export interface McpHost {
  /** Tools this host serves from its OWN process — i.e. the gateway-hosted half
   *  of a delegated agent's surface, narrowed to the `read` tier. The PROXIED
   *  half is re-derived per `tools/list` and is deliberately not in here; see
   *  `mcp-host/proxied-tool-surface.ts`. */
  readonly delegatedToolNames: readonly string[];
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Open a Unix listener for a freshly-provisioned user. Idempotent — a
   *  pre-existing socket for `userId` is left untouched. */
  addUser(userId: string): Promise<void>;
  /** Tear down a removed user's listener and unlink its socket. Idempotent. */
  removeUser(userId: string): Promise<void>;
}

export interface McpHostOptions {
  config: HermesConfig;
  router: ActiveSessionLookup;
  userStore: UserStore;
  audio: AudioControls;
  userSettings: UserSettingsControls;
  /** `config.yaml#mcp_catalog` — the operator's tier declarations. It is what
   *  says which of the gateway's own hosted tools a delegated agent may hold
   *  (through the `gateway:` entry's `tools.include`), and it is the catalog
   *  each delegated broker builds its delegator's permission floor from. */
  catalog: McpCatalog;
  /** Current per-user product permissions for gateway-hosted delegation tools. */
  profileStore: ProfileStore;
  /** The proxy tier's two dependencies. Absent when `orchestrator:` is not
   *  configured — the host then serves only its own hosted tools, which is the
   *  pre-9g behaviour rather than a failure. */
  proxy?: {
    mcpClient: McpClient;
    toolsConfig: OrchestratorConfig["tools"];
    /** Mints each delegated broker's authorization capability (spec §3.2). */
    accessManager: AccessManager;
    /** Supplies each delegated broker's per-tool permission reader, so a
     *  proxied call is bound by the delegating user's own Deny/Off settings —
     *  see mcp-host/delegated-broker.ts's header. */
    profileStore: ProfileStore;
    nativeToolsFor?: (principal: UserPrincipal) => Map<string, NativeToolRunner>;
  };
}

/** A hosted handler joined to the impact tier the operator declared for it, in
 *  the shape `selectDelegatedTools` reads. `tier: undefined` for a name the
 *  catalog does not curate — NOT a tier, and never widened into one: an
 *  operator who removes a tool from `mcp_catalog.gateway.tools.include` has
 *  removed it, and guessing a tier here would put it back. */
interface HostedToolWithTier {
  readonly name: string;
  readonly tier: ImpactTier | undefined;
  readonly handler: ToolHandler;
}

function withCatalogTier(catalog: McpCatalog): (handler: ToolHandler) => HostedToolWithTier {
  return (handler) => ({
    name: handler.def.name,
    tier: tierOf(catalog, handler.def.name),
    handler,
  });
}

/** Narrows away the untiered ones, and says so — an operator who dropped a
 *  hosted tool from the catalog should be able to see that it happened. */
function isTiered(tool: HostedToolWithTier): tool is HostedToolWithTier & { tier: ImpactTier } {
  if (tool.tier !== undefined) return true;
  log.warn("mcp-host.hosted-tool-untiered", {
    tool: tool.name,
    reason: "config.yaml#mcp_catalog does not curate this gateway-hosted tool, so no delegated agent may hold it",
  });
  return false;
}

/**
 * The two tiers behind one registry.
 *
 * HOSTED tools are fixed at construction: the gateway implements them, so their
 * surface cannot change at runtime. PROXIED tools are re-derived on every
 * `tools/list` (see `refreshTools` below), so a catalog server that comes up
 * after the gateway does is picked up without a restart.
 *
 * Lookup order is hosted-first. `proxied-tool-surface.ts` already drops a
 * catalog tool that collides with a hosted name, so this is belt-and-braces: it
 * guarantees the PDP decision and the executed code can never disagree even if
 * that filter is one day changed.
 */
type DynamicSurface = HostedToolSurface | ProxiedToolSurface | NativeToolSurface;

function buildRegistry(hosted: ToolHandler[], surfaces: readonly DynamicSurface[]): ToolRegistry {
  const hostedByName = new Map(hosted.map((h) => [h.def.name, h]));
  return {
    list: () => {
      const seen = new Set(hosted.map((handler) => handler.def.name));
      return [
        ...hosted.map((handler) => handler.def),
        ...surfaces.flatMap((surface) =>
          surface.definitions().filter((definition) => {
            if (seen.has(definition.name)) return false;
            seen.add(definition.name);
            return true;
          }),
        ),
      ];
    },
    get(name) {
      return hostedByName.get(name) ?? surfaces.map((surface) => surface.handler(name)).find(Boolean) ?? null;
    },
  };
}

export async function createMcpHost(options: McpHostOptions): Promise<McpHost> {
  const { config, router, userStore, audio, userSettings, catalog, profileStore, proxy } = options;
  const basePath = config.mcp_host.socket_path;

  // These sockets serve exactly ONE consumer: the delegated Hermes one-shot.
  // The gateway's own ReAct loop reaches its tools through `tools/tool-broker`
  // and `tools/mcp-client` (which skips stdio catalog entries outright), so
  // narrowing here narrows the SUB-AGENT's authority and nothing else.
  //
  // Why narrow at all: a delegated call arrives with no human attached, so
  // anything that would resolve to a permission prompt cannot be answered, and
  // `mcp-server.ts` has no confirmation mechanism to answer it with.
  // Advertising such a tool on this socket is therefore equivalent to granting
  // it unmediated. The tier comes from `config.yaml#mcp_catalog` at runtime —
  // never a second list.
  const hostedTools = [
    createIdentifyUserTool({ userStore }),
    createPauseAudioTool({ audio, router }),
    createResumeAudioTool({ audio, router }),
    createUpdateUserSettingsTool({ controls: userSettings, router }),
  ];
  const eligibleHosted = selectDelegatedTools(hostedTools.map(withCatalogTier(catalog)).filter(isTiered)).map(
    (tool) => tool.handler,
  );
  // This list is a provisioning sentinel: the per-user socket has potential
  // hosted capability. Actual advertisement is permission-filtered below.
  const delegatedToolNames = eligibleHosted.map((tool) => tool.def.name);

  // The PROXIED tier (task 9g). Every call through it is dispatched by a
  // per-user `ToolBroker`, so the gateway's PDP sees it — that mediation is the
  // entire reason the tier is allowed to exist.
  const hostedNames = new Set(hostedTools.map((tool) => tool.def.name));
  const brokerFor = proxy
    ? createDelegatedBrokerFactory({
        mcp: proxy.mcpClient,
        catalog,
        toolsConfig: proxy.toolsConfig,
        accessManager: proxy.accessManager,
        profileStore: proxy.profileStore,
        userStore,
        ...(proxy.nativeToolsFor ? { nativeToolsFor: proxy.nativeToolsFor } : {}),
      })
    : null;
  const proxiedSurface =
    proxy && brokerFor
      ? createProxiedToolSurface({
          listCatalogTools: () => proxy.mcpClient.listTools(),
          brokerFor,
          hostedNames,
        })
      : null;
  if (!proxiedSurface) {
    log.warn("mcp-host.no-proxy-tier", {
      reason: "no orchestrator config, so a delegated agent gets the gateway's hosted tools only",
    });
  }

  function buildListener(userId: string): UnixSocketListener {
    const socketPath = resolveMcpSocketPath(userId, basePath);
    const hostedSurface = createHostedToolSurface({
      userId,
      handlers: eligibleHosted,
      catalog,
      profileStore,
      userStore,
    });
    const nativeSurface = brokerFor ? createNativeToolSurface(userId, brokerFor, hostedNames) : null;
    // Gateway-hosted and native product definitions win a same-name collision:
    // core capability must never silently route through a third-party MCP.
    const surfaces: DynamicSurface[] = [hostedSurface, nativeSurface, proxiedSurface].filter(
      (surface): surface is DynamicSurface => surface !== null,
    );
    const registry = buildRegistry([], surfaces);
    const deps: McpServerDeps = {
      registry,
      contextFor: () => ({ sessionId: null, userId, sessionChannel: "voice" }),
      // Re-derive the proxied tier at the moment of use, symmetric with
      // `delegateTask`'s dispatch-time provisioning: no cached surface, no
      // drift. Bounded by each catalog entry's own `connect_timeout`.
      ...(surfaces.length > 0
        ? {
            refreshTools: async () => {
              await Promise.all(surfaces.map((surface) => surface.refresh()));
            },
          }
        : {}),
    };
    return createUnixSocketListener(socketPath, userId, deps);
  }

  const listenersByUser = new Map<string, UnixSocketListener>();
  let started = false;

  const usersResult = await userStore.list();
  const initialUserIds = usersResult.ok ? usersResult.value.map((u) => u.userId) : [];
  if (!usersResult.ok) {
    log.warn("mcp-host.user-list-failed", { error: usersResult.error });
  }
  for (const userId of initialUserIds) {
    listenersByUser.set(userId, buildListener(userId));
  }

  log.info("mcp-host-created", {
    users: initialUserIds,
    hostedToolCount: eligibleHosted.length,
    delegatedToolNames,
    proxyTier: proxiedSurface !== null,
  });

  return {
    delegatedToolNames,
    async start() {
      await Promise.all(Array.from(listenersByUser.values()).map((l) => l.start()));
      started = true;
      log.info("mcp-host-started", {
        sockets: Array.from(listenersByUser.keys()).map((id) => resolveMcpSocketPath(id, basePath)),
      });
    },
    async stop() {
      await Promise.all(Array.from(listenersByUser.values()).map((l) => l.stop()));
      listenersByUser.clear();
      started = false;
      log.info("mcp-host-stopped");
    },
    async addUser(userId: string) {
      if (listenersByUser.has(userId)) {
        log.debug("addUser.already-present", { userId });
        return;
      }
      const listener = buildListener(userId);
      listenersByUser.set(userId, listener);
      if (started) {
        await listener.start();
        log.info("addUser.listener-started", {
          userId,
          socketPath: resolveMcpSocketPath(userId, basePath),
        });
      }
    },
    async removeUser(userId: string) {
      const listener = listenersByUser.get(userId);
      if (!listener) {
        log.debug("removeUser.not-present", { userId });
        return;
      }
      listenersByUser.delete(userId);
      await listener.stop();
      log.info("removeUser.listener-stopped", { userId });
    },
  };
}
