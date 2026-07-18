import type { HermesConfig } from "@sentient/config";
import { describe, expect, it } from "vitest";
import type { UserPortStore } from "./admin/user-port-store.js";
import { createSessionRouter, renderWorkerUrl } from "./session-router.js";

const ALICE = "u_aaaaaaaa";
const BOB = "u_bbbbbbbb";
const CHARLIE = "u_cccccccc";

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

function makeStore(bindings: Map<string, number>): UserPortStore {
  return {
    list: async () => ({ ok: true, value: [...bindings].map(([userId, port]) => ({ userId, port })) }),
    bind: async (userId: string) => {
      const port = 8650 + bindings.size;
      bindings.set(userId, port);
      return { ok: true, value: { userId, port } };
    },
    unbind: async (userId: string) => {
      bindings.delete(userId);
      return { ok: true, value: undefined };
    },
    resolvePort: async (userId: string) => bindings.get(userId) ?? null,
  };
}

const FAKE_TOKEN = "fake-internal-token";
const fakeResolver = () => FAKE_TOKEN;

function makeRouter(initial: Array<[string, number]> = []) {
  const bindings = new Map<string, number>(initial);
  const userPortStore = makeStore(bindings);
  return createSessionRouter({ hermes: baseConfig, userPortStore, apiKeyResolver: fakeResolver });
}

describe("renderWorkerUrl", () => {
  it("substitutes {port}", () => {
    expect(renderWorkerUrl("http://h:{port}", 8651)).toBe("http://h:8651");
  });
});

describe("SessionRouter", () => {
  it("resolves binding by userId via user-port-store", async () => {
    const router = makeRouter([
      [ALICE, 8650],
      [BOB, 8651],
    ]);
    const b = await router.bind("sess-1", BOB, "surf-1");
    expect(b.userId).toBe(BOB);
    expect(b.url).toBe("http://sentient-hermes:8651");
    expect(b.apiKey).toBe(FAKE_TOKEN);
    expect(b.conversationId).toBeNull();
  });

  it("throws when userId has no port binding", async () => {
    const router = makeRouter([[ALICE, 8650]]);
    await expect(router.bind("sess-1", CHARLIE, "surf-1")).rejects.toThrow(/no port binding/);
  });

  it("throws on malformed userId", async () => {
    const router = makeRouter();
    await expect(router.bind("sess-1", "admin", "surf-1")).rejects.toThrow(/invalid userId/);
  });

  it("get() returns a binding with null conversationId (anchors moved to PersonSession)", async () => {
    const router = makeRouter([[ALICE, 8650]]);
    await router.bind("sess-1", ALICE, "surf-1");
    expect(router.get("sess-1")?.conversationId).toBeNull();
  });

  it("rebind to different user updates userId and keeps conversationId null", async () => {
    const router = makeRouter([
      [ALICE, 8650],
      [BOB, 8651],
    ]);
    await router.bind("sess-1", ALICE, "surf-1");
    const after = await router.rebind("sess-1", BOB);
    expect(after.userId).toBe(BOB);
    expect(after.conversationId).toBeNull();
    expect(router.get("sess-1")?.userId).toBe(BOB);
    expect(router.get("sess-1")?.conversationId).toBeNull();
  });

  it("throws on rebind of unknown session", async () => {
    const router = makeRouter([[ALICE, 8650]]);
    await expect(router.rebind("missing", ALICE)).rejects.toThrow(/rebind/);
  });

  it("findActiveSessionFor returns most recent session for userId", async () => {
    const router = makeRouter([
      [ALICE, 8650],
      [BOB, 8651],
    ]);
    await router.bind("sess-1", ALICE, "surf-1");
    await router.bind("sess-2", BOB, "surf-2");
    await router.bind("sess-3", ALICE, "surf-3");
    expect(router.findActiveSessionFor(ALICE)).toBe("sess-3");
    expect(router.findActiveSessionFor(BOB)).toBe("sess-2");
  });

  it("findActiveSessionFor returns null when no session for userId", async () => {
    const router = makeRouter([
      [ALICE, 8650],
      [BOB, 8651],
    ]);
    await router.bind("sess-1", ALICE, "surf-1");
    expect(router.findActiveSessionFor(BOB)).toBeNull();
  });

  it("get returns null for unknown session", () => {
    const router = makeRouter();
    expect(router.get("ghost")).toBeNull();
  });

  it("release removes binding", async () => {
    const router = makeRouter([[ALICE, 8650]]);
    await router.bind("sess-1", ALICE, "surf-1");
    expect(router.get("sess-1")).not.toBeNull();
    router.release("sess-1");
    expect(router.get("sess-1")).toBeNull();
  });
});
