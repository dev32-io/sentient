import { describe, expect, it } from "vitest";
import type { InstallState, InstallStateData } from "../../admin/install-state.js";
import { createInstallStateHandler } from "./install-state.js";

function makeState(overrides: Partial<InstallStateData> = {}): InstallStateData {
  return {
    schema_version: "1.0.0",
    installed_version: "1.0.0",
    last_upgraded_from: null,
    last_upgraded_at: null,
    bootstrap_complete: false,
    wizard_cursor: "provider",
    unlock_verified: false,
    ...overrides,
  };
}

function makeService(state: InstallStateData): InstallState {
  return {
    load: async () => state,
    advanceCursor: async () => ({ ok: true, value: undefined }),
    retreatCursor: async () => ({ ok: true, value: undefined }),
    setUnlockVerified: async () => ({ ok: true, value: undefined }),
    finish: async () => ({ ok: true, value: undefined }),
  };
}

describe("install-state handler", () => {
  it("returns full state shape", async () => {
    const handler = createInstallStateHandler({
      installState: makeService(makeState()),
      currentVersion: "1.0.0",
    });
    const res = await handler(new Request("http://localhost/api/v1/install-state"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      bootstrap_complete: false,
      wizard_cursor: "provider",
      unlock_verified: false,
      installed_version: "1.0.0",
      current_version: "1.0.0",
    });
  });

  it("reflects post-bootstrap state", async () => {
    const handler = createInstallStateHandler({
      installState: makeService(
        makeState({ bootstrap_complete: true, wizard_cursor: "finish", unlock_verified: true }),
      ),
      currentVersion: "1.0.0",
    });
    const res = await handler(new Request("http://localhost/api/v1/install-state"));
    const body = await res.json();
    expect(body.bootstrap_complete).toBe(true);
    expect(body.wizard_cursor).toBe("finish");
  });

  it("rejects non-GET requests with 405", async () => {
    const handler = createInstallStateHandler({ installState: makeService(makeState()), currentVersion: "1.0.0" });
    const res = await handler(new Request("http://localhost/api/v1/install-state", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  it("returns 500 with structured body when load() throws", async () => {
    const failing: InstallState = {
      load: async () => {
        throw new Error("corrupt yaml");
      },
      advanceCursor: async () => ({ ok: true, value: undefined }),
      retreatCursor: async () => ({ ok: true, value: undefined }),
      setUnlockVerified: async () => ({ ok: true, value: undefined }),
      finish: async () => ({ ok: true, value: undefined }),
    };
    const handler = createInstallStateHandler({ installState: failing, currentVersion: "1.0.0" });
    const res = await handler(new Request("http://localhost/api/v1/install-state"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("state-load-failed");
    expect(body.reason).toBe("corrupt yaml");
  });
});
