import { describe, expect, it } from "bun:test";
import { createSessionBlockRenderer } from "./session-block.js";

const AT = Date.UTC(2026, 7, 5, 13, 12, 3);

const deps = (over: Partial<Parameters<typeof createSessionBlockRenderer>[0]> = {}) =>
  createSessionBlockRenderer({
    clock: { nowMs: () => AT },
    timeZone: { zone: () => "America/Toronto" },
    identity: { describe: async () => ({ speaking: "Kevin", household: ["Sam"] }) },
    continuity: { describe: () => ({ kind: "new" }) },
    sessionId: "s1",
    ...over,
  });

describe("createSessionBlockRenderer", () => {
  it("dates the session in the household's zone, with weekday and offset", async () => {
    const block = await deps().render();
    expect(block).toContain("started: 2026-08-05T09:12:03-04:00 (Wednesday)");
    expect(block).toContain("timezone: America/Toronto");
  });

  it("names who is speaking and who else is in the household", async () => {
    // The system prompt promises "any of them may be speaking to you" and
    // "never another person's private data" — instructions the model had no
    // way to apply while nothing told it who was on the other end.
    const block = await deps().render();
    expect(block).toContain("speaking with: Kevin");
    expect(block).toContain("household: Sam");
  });

  it("says when a resumed conversation was last active", async () => {
    const block = await deps({
      continuity: { describe: () => ({ kind: "resumed", lastActiveAtMs: AT - 14 * 60 * 60 * 1000 }) },
    }).render();
    expect(block).toContain("continuity: resumed, last active 2026-08-04T19:12:03-04:00");
  });

  it("still renders the clock when the identity lookup fails", async () => {
    const block = await deps({
      identity: {
        describe: async () => {
          throw new Error("user store unreachable");
        },
      },
    }).render();

    expect(block).toContain("started: ");
    expect(block).not.toContain("speaking with:");
  });
});
