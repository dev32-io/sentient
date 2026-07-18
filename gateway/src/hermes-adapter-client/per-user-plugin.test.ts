import type { HermesConfig } from "@sentient/config";
import { describe, expect, it } from "vitest";
import type { UserPortStore } from "../admin/user-port-store.js";
import type { AcpPerProfileConnection } from "./per-profile-connection.js";
import type { PerUserPluginDeps } from "./per-user-plugin.js";
import { listSessionsForUser } from "./per-user-plugin.js";
import type { AcpWireBootstrapResult } from "./wire-bootstrap.js";

// ---------------------------------------------------------------------------
// listSessionsForUser — dials its own ephemeral ACP wire via `wireFactory`
// (defaults to bootstrapAcpWire) rather than going through the shared
// AcpWireRegistry pool. It disposes the wire in `finally`, regardless of
// whether listSessionsViaAcp succeeds or throws.
// ---------------------------------------------------------------------------

const USER_ID = "u_00000001";

const baseConfig: HermesConfig = {
  worker: {
    container_name: "sentient-hermes",
    url_template: "http://sentient-hermes:{port}",
    port_base: 8650,
  },
  acp_wire: {
    open_timeout_ms: 5000,
    reconnect_base_ms: 500,
    reconnect_max_ms: 5000,
    reconnect_jitter_ms: 250,
    reconnect_max_attempts: 5,
  },
  defaults: { max_output_tokens: 512 },
  web_tools: {
    provider: "searxng",
    searxng: { enabled: true },
    voice_wrapper: { enabled: false },
  },
  home_assistant_observer: {
    enabled: false,
    token_env: "HA_OBSERVE_TOKEN",
    watch_domains: [],
    watch_entities: [],
    ignore_entities: [],
    duplicate_state_window_ms: 10000,
  },
  mcp_host: { transport: "unix_socket", socket_path: "/run/sentient/mcp.sock" },
  satellite_devices: [],
  ambient: {
    event_log: { enabled: true, retention_count: 10000, persist_path: "./data/ambient-events.db" },
    dispatch: { steward_enabled: false, accumulation_window_ms: 2000 },
  },
  tts: { markdown_stripping_enabled: true, emoji_stripping_enabled: true },
};

function makeUserPortStore(): UserPortStore {
  return {
    list: async () => ({ ok: true, value: [{ userId: USER_ID, port: 8650 }] }),
    bind: async (userId: string) => ({ ok: true, value: { userId, port: 8650 } }),
    unbind: async () => ({ ok: true, value: undefined }),
    resolvePort: async (userId: string) => (userId === USER_ID ? 8650 : null),
  };
}

function makeEmptyListConn(): AcpPerProfileConnection {
  return {
    listSessions: async () => ({ sessions: [], nextCursor: null }),
  } as unknown as AcpPerProfileConnection;
}

function makePerUserDeps(overrides: Partial<PerUserPluginDeps> = {}): PerUserPluginDeps {
  return {
    hermes: baseConfig,
    userPortStore: makeUserPortStore(),
    hermesApiKey: () => "fake-internal-token",
    timeoutMs: 5000,
    acpOpenTimeoutMs: 5000,
    ...overrides,
  };
}

describe("listSessionsForUser", () => {
  it("disposes the ephemeral wire after listing", async () => {
    let disposed = 0;
    const deps = makePerUserDeps({
      wireFactory: async () =>
        ({
          acpConn: makeEmptyListConn(),
          dispose: () => {
            disposed++;
          },
        }) satisfies AcpWireBootstrapResult,
    });

    const result = await listSessionsForUser(USER_ID, deps);

    expect(result).toEqual([]);
    expect(disposed).toBe(1);
  });

  it("disposes the ephemeral wire even when listSessionsViaAcp throws", async () => {
    let disposed = 0;
    const deps = makePerUserDeps({
      wireFactory: async () =>
        ({
          acpConn: {
            listSessions: async () => {
              throw new Error("boom");
            },
          } as unknown as AcpPerProfileConnection,
          dispose: () => {
            disposed++;
          },
        }) satisfies AcpWireBootstrapResult,
    });

    await expect(listSessionsForUser(USER_ID, deps)).rejects.toThrow("boom");
    expect(disposed).toBe(1);
  });

  it("passes wsUrl, token, and openTimeoutMs through to wireFactory", async () => {
    const calls: Array<{ wsUrl: string; token: string; openTimeoutMs: number }> = [];
    const deps = makePerUserDeps({
      hermesApiKey: () => "the-token",
      acpOpenTimeoutMs: 1234,
      wireFactory: async (args) => {
        calls.push(args);
        return { acpConn: makeEmptyListConn(), dispose: () => {} };
      },
    });

    await listSessionsForUser(USER_ID, deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe("the-token");
    expect(calls[0]?.openTimeoutMs).toBe(1234);
    expect(calls[0]?.wsUrl).toContain("sentient-hermes:8650");
  });
});
