import type { HermesConfig } from "@sentient/config";
import { beforeEach, describe, expect, it } from "vitest";
import type { UserPortStore } from "../admin/user-port-store.js";
import { type PersonSessionRegistry, createPersonSessionRegistry } from "./person-session-registry.js";
import type { PersonSessionAttachment } from "./person-session.js";

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

const FAKE_TOKEN = "resolved-internal-token";

function makeStore(bindings: Map<string, number>): UserPortStore {
  return {
    list: async () => ({ ok: true, value: [...bindings].map(([userId, port]) => ({ userId, port })) }),
    bind: async (userId: string) => ({ ok: true, value: { userId, port: 8650 + bindings.size } }),
    unbind: async () => ({ ok: true, value: undefined }),
    resolvePort: async (userId: string) => bindings.get(userId) ?? null,
  };
}

const TTL_MS = 30_000;
const REPLAY_BYTES = 65_536;

function makeAttachment(id: string): PersonSessionAttachment {
  return { attachmentId: id };
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
      idleTimeoutMs: TTL_MS,
      replayBufferMaxBytes: REPLAY_BYTES,
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

// ---------------------------------------------------------------------------
// Registry retention sweep (no real timers — call sweep() directly)
// ---------------------------------------------------------------------------

describe("PersonSessionRegistry.sweep", () => {
  function makeRegistry() {
    const userPortStore = makeStore(
      new Map([
        [ALICE, 8650],
        [BOB, 8651],
      ]),
    );
    return createPersonSessionRegistry({
      hermes: CONFIG,
      userPortStore,
      apiKeyResolver: () => FAKE_TOKEN,
      idleTimeoutMs: TTL_MS,
      replayBufferMaxBytes: REPLAY_BYTES,
    });
  }

  it("does not remove a session that has a live retained device buffer (attached, within idle window)", async () => {
    const reg = makeRegistry();
    const session = await reg.getOrCreate(ALICE);
    expect(session).not.toBeNull();

    // Acquire a surface buffer — still attached (not released).
    // Clock was just stamped at acquire time; nowMs is far future but idleTimeoutMs
    // is also very large so the buffer is NOT idle yet.
    session?.acquireDeviceBuffer("surf-phone", { deviceId: "dev-phone" });

    // Sweep with a nowMs just 1 second past acquisition — well within any idle window.
    const result = reg.sweep(Date.now() + 1_000);
    expect(result.sessionsRemoved).toBe(0);
    expect(reg.get(ALICE)).not.toBeNull();
  });

  it("removes a session once all its device buffers are swept idle", async () => {
    const reg = makeRegistry();
    const session = await reg.getOrCreate(ALICE);
    expect(session).not.toBeNull();

    // Acquire then detach a surface buffer.
    const att = makeAttachment("ws-1");
    session?.attach(att);
    session?.acquireDeviceBuffer("surf-phone", { deviceId: "dev-phone" });
    session?.detach(att);
    session?.releaseDeviceBuffer("surf-phone");

    // Sweep far in the future — past the idle timeout.
    const result = reg.sweep(Date.now() + TTL_MS + 60_000);
    expect(result.sessionsChecked).toBeGreaterThanOrEqual(1);
    expect(result.sessionsRemoved).toBe(1);
    expect(reg.get(ALICE)).toBeNull();
  });

  it("keeps an active session with a live buffer and removes the empty idle one", async () => {
    const reg = makeRegistry();
    const alice = await reg.getOrCreate(ALICE);
    const bob = await reg.getOrCreate(BOB);
    expect(alice).not.toBeNull();
    expect(bob).not.toBeNull();

    // Alice has an acquired surface buffer (still attached, recently stamped).
    alice?.acquireDeviceBuffer("surf-alice", { deviceId: "dev-alice" });

    // Bob has no device buffers — hasRetainedBuffers() is false → removed immediately.
    const result = reg.sweep(Date.now() + 1_000);
    expect(result.sessionsRemoved).toBe(1);
    expect(reg.get(ALICE)).not.toBeNull(); // still live (has retained buffer)
    expect(reg.get(BOB)).toBeNull(); // evicted (no buffers)
  });

  it("does not remove a session that still has a retained device buffer (even when idle timeout is large)", async () => {
    const reg = makeRegistry();
    const session = await reg.getOrCreate(ALICE);
    expect(session).not.toBeNull();

    // Acquire a surface buffer but do NOT release it → hasRetainedBuffers() = true.
    const att = makeAttachment("ws-1");
    session?.attach(att);
    session?.acquireDeviceBuffer("surf-phone", { deviceId: "dev-phone" });
    session?.detach(att);
    // Buffer still attached (not released) — idle sweep won't remove attached entries
    // unless forceClose fires (and we haven't registered one here).

    const result = reg.sweep(Date.now() + TTL_MS + 60_000);
    expect(result.sessionsRemoved).toBe(0);
    expect(reg.get(ALICE)).not.toBeNull();
  });
});
