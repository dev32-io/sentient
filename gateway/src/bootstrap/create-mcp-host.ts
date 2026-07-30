import type { HermesConfig } from "@sentient/config";
import { selectDelegatedAllowTier } from "../external-tools/delegated-tool-tier.js";
import { getLog } from "../logging/logger.js";
import type { ActiveSessionLookup } from "../mcp-host/active-session-lookup.js";
import type { McpServerDeps } from "../mcp-host/mcp-server.js";
import { resolveMcpSocketPath } from "../mcp-host/socket-path.js";
import { createToolRegistry } from "../mcp-host/tool-registry.js";
import type { AudioControls } from "../mcp-host/tools/audio-tools.js";
import { createPauseAudioTool, createResumeAudioTool } from "../mcp-host/tools/audio-tools.js";
import { createIdentifyUserTool } from "../mcp-host/tools/identify-user.js";
import { type UserSettingsControls, createUpdateUserSettingsTool } from "../mcp-host/tools/update-user-settings.js";
import { type UnixSocketListener, createUnixSocketListener } from "../mcp-host/unix-socket-listener.js";
import type { PolicyEngine } from "../security/policy-engine.js";
import type { UserStore } from "../user-auth/user-store.js";

const log = getLog(["sentient", "bootstrap", "mcp-host"]);

export interface McpHost {
  /** Tools this host advertises on the per-user sockets — i.e. the exact
   *  surface a delegated agent holds. Narrowed to the `allow` tier; see the
   *  registry construction below for why that narrowing is the security
   *  boundary and not a nicety. */
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
}

export async function createMcpHost(options: McpHostOptions): Promise<McpHost> {
  const { config, router, userStore, audio, userSettings, policy } = options;
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
  );
  const delegated = new Set(delegatedToolNames);
  const registry = createToolRegistry(hostedTools.filter((tool) => delegated.has(tool.def.name)));

  function buildListener(userId: string): UnixSocketListener {
    const socketPath = resolveMcpSocketPath(userId, basePath);
    const deps: McpServerDeps = {
      registry,
      policy,
      contextFor: () => ({ sessionId: null, userId, role: "user", sessionChannel: "voice" }),
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
    toolCount: registry.list().length,
    delegatedToolNames,
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
