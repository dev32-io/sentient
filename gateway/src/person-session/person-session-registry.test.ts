import type { HermesConfig } from "@sentient/config";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserPortStore } from "../admin/user-port-store.js";
import { type PersonSessionRegistry, createPersonSessionRegistry } from "./person-session-registry.js";

const ALICE = "u_aaaaaaaa";
const BOB = "u_bbbbbbbb";
const GHOST = "u_ffffffff";

const CONFIG: HermesConfig = {
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
  defaults: { max_output_tokens: 512, request_timeout_ms: 60000, idempotency_window_s: 300 },
  resource_management: {
    mode: "always_on",
    max_concurrent: 3,
    idle_pause_after_ms: 900000,
    idle_stop_after_ms: 3600000,
    ram_pressure_threshold_pct: 85,
    cold_start_filler_text: "one sec...",
  },
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

const FAKE_TOKEN = "resolved-internal-token";

function makeStore(bindings: Map<string, number>): UserPortStore {
  return {
    list: async () => ({ ok: true, value: [...bindings].map(([userId, port]) => ({ userId, port })) }),
    bind: async (userId: string) => ({ ok: true, value: { userId, port: 8650 + bindings.size } }),
    unbind: async () => ({ ok: true, value: undefined }),
    resolvePort: async (userId: string) => bindings.get(userId) ?? null,
  };
}

describe("PersonSessionRegistry", () => {
  let registry: PersonSessionRegistry;

  beforeEach(() => {
    const userPortStore = makeStore(
      new Map([
        [ALICE, 8650],
        [BOB, 8651],
      ]),
    );
    registry = createPersonSessionRegistry({
      hermes: CONFIG,
      userPortStore,
      apiKeyResolver: () => FAKE_TOKEN,
    });
  });

  it("creates a PersonSession on first getOrCreate", async () => {
    const s = await registry.getOrCreate(ALICE);
    expect(s).not.toBeNull();
    expect(s?.userId).toBe(ALICE);
    expect(s?.hermesUrl).toBe("http://sentient-hermes:8650");
    expect(s?.hermesApiKey).toBe(FAKE_TOKEN);
  });

  it("returns the same instance on subsequent getOrCreate", async () => {
    const first = await registry.getOrCreate(ALICE);
    const second = await registry.getOrCreate(ALICE);
    expect(second).toBe(first);
  });

  it("creates independent PersonSessions for different users", async () => {
    const alice = await registry.getOrCreate(ALICE);
    const bob = await registry.getOrCreate(BOB);
    expect(alice).not.toBe(bob);
    expect(alice?.hermesUrl).not.toBe(bob?.hermesUrl);
  });

  it("get returns null for an unknown user", () => {
    expect(registry.get(ALICE)).toBeNull();
  });

  it("get returns the created session after getOrCreate", async () => {
    const created = await registry.getOrCreate(ALICE);
    expect(registry.get(ALICE)).toBe(created);
  });

  it("list returns a snapshot of all live sessions", async () => {
    await registry.getOrCreate(ALICE);
    await registry.getOrCreate(BOB);
    const all = registry.list();
    expect(all).toHaveLength(2);
    const userIds = all.map((s) => s.userId).sort();
    expect(userIds).toEqual([ALICE, BOB]);
  });

  it("returns null when the user has no port binding", async () => {
    expect(await registry.getOrCreate(GHOST)).toBeNull();
  });
});
