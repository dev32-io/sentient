import { describe, expect, it } from "bun:test";
import { createHealthWatch } from "./health-watch.js";

describe("health-watch", () => {
  it("INVARIANT: an unhealthy service triggers exactly one re-apply", async () => {
    const applied: string[] = [];
    let healthy = false;
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => healthy,
      reapply: async (name) => {
        applied.push(name);
        healthy = true;
      },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 60));
    watch.stop();
    expect(applied).toEqual(["local-tts"]); // recovered, and NOT re-applied once healthy
  });

  it("INVARIANT: a healthy service is never re-applied", async () => {
    const applied: string[] = [];
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => true,
      reapply: async (name) => {
        applied.push(name);
      },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 60));
    watch.stop();
    expect(applied).toEqual([]);
  });

  it("INVARIANT: stop() ends the loop — no re-apply after shutdown", async () => {
    const applied: string[] = [];
    const watch = createHealthWatch({
      intervalMs: 10,
      listServices: () => ["local-tts"],
      probe: async () => false,
      reapply: async (name) => {
        applied.push(name);
      },
    });
    watch.start();
    await new Promise((r) => setTimeout(r, 25));
    watch.stop();
    const countAtStop = applied.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(applied.length).toBe(countAtStop);
  });
});
