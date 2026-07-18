import type { HermesConfig } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import type { McpServerDeps } from "../mcp-host/mcp-server.js";
import { createToolRegistry } from "../mcp-host/tool-registry.js";
import type { AudioControls } from "../mcp-host/tools/audio-tools.js";
import { createPauseAudioTool, createResumeAudioTool } from "../mcp-host/tools/audio-tools.js";
import { createIdentifyUserTool } from "../mcp-host/tools/identify-user.js";
import { type UserSettingsControls, createUpdateUserSettingsTool } from "../mcp-host/tools/update-user-settings.js";
import { type UnixSocketListener, createUnixSocketListener } from "../mcp-host/unix-socket-listener.js";
import type { PolicyEngine } from "../security/policy-engine.js";
import type { SessionRouter } from "../session-router.js";
import type { UserStore } from "../user-auth/user-store.js";

const log = getLog(["sentient", "bootstrap", "mcp-host"]);

export interface McpHost {
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
  router: SessionRouter;
  userStore: UserStore;
  audio: AudioControls;
  userSettings: UserSettingsControls;
  policy: PolicyEngine;
}

/** Derive per-user socket path from the base path. */
function userSocketPath(basePath: string, userId: string): string {
  const dir = basePath.substring(0, basePath.lastIndexOf("/") + 1);
  return `${dir}mcp-${userId}.sock`;
}

export async function createMcpHost(options: McpHostOptions): Promise<McpHost> {
  const { config, router, userStore, audio, userSettings, policy } = options;
  const basePath = config.mcp_host.socket_path;

  const registry = createToolRegistry([
    createIdentifyUserTool({ userStore }),
    createPauseAudioTool({ audio, router }),
    createResumeAudioTool({ audio, router }),
    createUpdateUserSettingsTool({ controls: userSettings, router }),
  ]);

  function buildListener(userId: string): UnixSocketListener {
    const socketPath = userSocketPath(basePath, userId);
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
  });

  return {
    async start() {
      await Promise.all(Array.from(listenersByUser.values()).map((l) => l.start()));
      started = true;
      log.info("mcp-host-started", {
        sockets: Array.from(listenersByUser.keys()).map((id) => userSocketPath(basePath, id)),
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
        log.info("addUser.listener-started", { userId, socketPath: userSocketPath(basePath, userId) });
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
