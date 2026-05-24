// Tag: @live — only runs with HERMES_ALICE_LIVE=1
import { describe, expect, it } from "vitest";
import { createDockerControl } from "../../src/infrastructure/docker-control.js";

const RUN_LIVE = process.env.HERMES_ALICE_LIVE === "1";

describe.skipIf(!RUN_LIVE)("docker-control integration — real hermes-alice", () => {
  it("docker restart hermes-alice exits 0 within 15s", async () => {
    const dc = createDockerControl();
    const startedAt = Date.now();
    const r = await dc.restart("hermes-alice", 30_000);
    const elapsedMs = Date.now() - startedAt;
    expect(r.ok).toBe(true);
    expect(elapsedMs).toBeLessThan(15_000);
  }, 30_000);

  it("docker restart on a missing container returns non-zero-exit", async () => {
    const dc = createDockerControl();
    const r = await dc.restart("hermes-does-not-exist", 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("non-zero-exit");
  }, 10_000);
});
