import type { HermesConfig, OrchestratorConfig } from "@sentient/config";
import { HOSTED_TOOL_CONTEXT, selectDelegatedAllowTier } from "../external-tools/delegated-tool-tier.js";
import { getLog } from "../logging/logger.js";
import type { ActiveSessionLookup } from "../mcp-host/active-session-lookup.js";
import { createDelegatedBrokerFactory } from "../mcp-host/delegated-broker.js";
import type { McpServerDeps, ToolHandler, ToolRegistry } from "../mcp-host/mcp-server.js";
import { type ProxiedToolSurface, createProxiedToolSurface } from "../mcp-host/proxied-tool-surface.js";
import { resolveMcpSocketPath } from "../mcp-host/socket-path.js";
import type { AudioControls } from "../mcp-host/tools/audio-tools.js";
import { createPauseAudioTool, createResumeAudioTool } from "../mcp-host/tools/audio-tools.js";
import { createIdentifyUserTool } from "../mcp-host/tools/identify-user.js";
import { type UserSettingsControls, createUpdateUserSettingsTool } from "../mcp-host/tools/update-user-settings.js";
import { type UnixSocketListener, createUnixSocketListener } from "../mcp-host/unix-socket-listener.js";
import type { PolicyEngine } from "../security/policy-engine.js";
import type { McpClient } from "../tools/mcp-client.js";
import type { UserStore } from "../user-auth/user-store.js";

const log = getLog(["sentient", "bootstrap", "mcp-host"]);

export interface McpHost {
  /** Tools this host serves from its OWN process — i.e. the gateway-hosted half
   *  of a delegated agent's surface, narrowed to the `allow` tier. The PROXIED
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
  policy: PolicyEngine;
  /** The proxy tier's two dependencies. Absent when `orchestrator:` is not
   *  configured — the host then serves only its own hosted tools, which is the
   *  pre-9g behaviour rather than a failure. */
  proxy?: {
    mcpClient: McpClient;
    toolsConfig: OrchestratorConfig["tools"];
  };
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
function buildRegistry(hosted: ToolHandler[], surface: ProxiedToolSurface | null): ToolRegistry {
  const hostedByName = new Map(hosted.map((h) => [h.def.name, h]));
  return {
    list() {
      return [...hosted.map((h) => h.def), ...(surface?.definitions() ?? [])];
    },
    get(name) {
      return hostedByName.get(name) ?? surface?.handler(name) ?? null;
    },
  };
}

export async function createMcpHost(options: McpHostOptions): Promise<McpHost> {
  const { config, router, userStore, audio, userSettings, policy, proxy } = options;
  const basePath = config.mcp_host.socket_path;

  // These sockets serve exactly ONE consumer: the delegated Hermes one-shot.
  // The gateway's own ReAct loop reaches its tools through `tools/tool-broker`
  // and `tools/mcp-client` (which skips stdio catalog entries outright), so
  // narrowing here narrows the SUB-AGENT's authority and nothing else.
  //
  // Why narrow at all: a delegated call arrives with no human attached, so the
  // PDP's `confirm` verdict has nobody to prompt and `mcp-server.ts`
  // auto-approves it. Advertising a `confirm`-tier tool on this socket is
  // therefore equivalent to granting it unmediated. The tier comes from
  // `mcp-policy.yaml` at runtime — never a second list.
  const hostedTools = [
    createIdentifyUserTool({ userStore }),
    createPauseAudioTool({ audio, router }),
    createResumeAudioTool({ audio, router }),
    createUpdateUserSettingsTool({ controls: userSettings, router }),
  ];
  const delegatedToolNames = selectDelegatedAllowTier(
    policy,
    hostedTools.map((tool) => tool.def.name),
    HOSTED_TOOL_CONTEXT,
  );
  const delegated = new Set(delegatedToolNames);
  const hosted = hostedTools.filter((tool) => delegated.has(tool.def.name));

  // The PROXIED tier (task 9g). Every call through it is dispatched by a
  // per-user `ToolBroker`, so the gateway's PDP sees it — that mediation is the
  // entire reason the tier is allowed to exist.
  const proxiedSurface = proxy
    ? createProxiedToolSurface({
        listCatalogTools: () => proxy.mcpClient.listTools(),
        policy,
        brokerFor: createDelegatedBrokerFactory({
          mcp: proxy.mcpClient,
          policy,
          toolsConfig: proxy.toolsConfig,
        }),
        hostedNames: new Set(hostedTools.map((tool) => tool.def.name)),
      })
    : null;
  if (!proxiedSurface) {
    log.warn("mcp-host.no-proxy-tier", {
      reason: "no orchestrator config, so a delegated agent gets the gateway's hosted tools only",
    });
  }

  const registry = buildRegistry(hosted, proxiedSurface);

  function buildListener(userId: string): UnixSocketListener {
    const socketPath = resolveMcpSocketPath(userId, basePath);
    const deps: McpServerDeps = {
      registry,
      policy,
      contextFor: () => ({ sessionId: null, userId, role: "user", sessionChannel: "voice" }),
      // Re-derive the proxied tier at the moment of use, symmetric with
      // `delegateTask`'s dispatch-time provisioning: no cached surface, no
      // drift. Bounded by each catalog entry's own `connect_timeout`.
      ...(proxiedSurface ? { refreshTools: () => proxiedSurface.refresh() } : {}),
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
    hostedToolCount: hosted.length,
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
        log.info("addUser.listener-started", { userId, socketPath: resolveMcpSocketPath(userId, basePath) });
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
