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

  it("updateConversationId mutates stored binding", async () => {
    const router = makeRouter([[ALICE, 8650]]);
    await router.bind("sess-1", ALICE, "surf-1");
    router.updateConversationId("surf-1", "conv-abc-123");
    expect(router.get("sess-1")?.conversationId).toBe("conv-abc-123");
  });

  it("updateConversationId is a no-op for unknown session", () => {
    const router = makeRouter();
    expect(() => router.updateConversationId("ghost", "conv-x")).not.toThrow();
  });

  it("rebind to different user resets conversationId", async () => {
    const router = makeRouter([
      [ALICE, 8650],
      [BOB, 8651],
    ]);
    await router.bind("sess-1", ALICE, "surf-1");
    router.updateConversationId("surf-1", "conv-alice-1");
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

  it("clearConversationIdForAllSessions clears matching userId only", async () => {
    const router = makeRouter([
      [ALICE, 8650],
      [BOB, 8651],
    ]);
    await router.bind("sess-alice-1", ALICE, "surf-alice-1");
    await router.bind("sess-alice-2", ALICE, "surf-alice-2");
    await router.bind("sess-bob-1", BOB, "surf-bob-1");
    router.updateConversationId("surf-alice-1", "conv-A");
    router.updateConversationId("surf-alice-2", "conv-B");
    router.updateConversationId("surf-bob-1", "conv-X");

    router.clearConversationIdForAllSessions(ALICE);

    expect(router.get("sess-alice-1")?.conversationId).toBeNull();
    expect(router.get("sess-alice-2")?.conversationId).toBeNull();
    expect(router.get("sess-bob-1")?.conversationId).toBe("conv-X");
  });
});

describe("SessionRouter — conversation anchor survives transport handover (D2)", () => {
  function makeDeps() {
    const bindings = new Map<string, number>([[ALICE, 8650]]);
    const userPortStore = makeStore(bindings);
    return { hermes: baseConfig, userPortStore, apiKeyResolver: fakeResolver };
  }

  it("a new sessionId on the SAME surface reads the conversationId anchored by the prior transport", async () => {
    const router = createSessionRouter(makeDeps());
    await router.bind("sess_old", ALICE, "surface_a");
    router.updateConversationId("surface_a", "conv_42");
    router.release("sess_old");
    await router.bind("sess_new", ALICE, "surface_a");
    expect(router.get("sess_new")?.conversationId).toBe("conv_42");
  });

  it("updateConversationId after the originating transport was released still lands on the surface anchor", async () => {
    const router = createSessionRouter(makeDeps());
    await router.bind("sess_old", ALICE, "surface_a");
    await router.bind("sess_new", ALICE, "surface_a");
    router.release("sess_old");
    router.updateConversationId("surface_a", "conv_99");
    expect(router.get("sess_new")?.conversationId).toBe("conv_99");
  });

  it("two different surfaces do not share an anchor", async () => {
    const router = createSessionRouter(makeDeps());
    await router.bind("sess_a", ALICE, "surface_a");
    await router.bind("sess_b", ALICE, "surface_b");
    router.updateConversationId("surface_a", "conv_a");
    expect(router.get("sess_b")?.conversationId).toBeNull();
  });

  it("dropAnchor removes a surface's anchor (anchor lifetime == surface lifetime)", async () => {
    const router = createSessionRouter(makeDeps());
    await router.bind("sess_a", ALICE, "surface_a");
    router.updateConversationId("surface_a", "conv_42");
    router.dropAnchor("surface_a");
    // a fresh bind on the same surfaceId now sees no stale anchor
    await router.bind("sess_b", ALICE, "surface_a");
    expect(router.get("sess_b")?.conversationId).toBeNull();
  });
});
