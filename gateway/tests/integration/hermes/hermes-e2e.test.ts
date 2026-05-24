import { describe, expect, it } from "vitest";
import { HttpHermesClient } from "../../../src/cerebrum/hermes-client";
import type { HermesProfileBinding } from "../../../src/cerebrum/hermes-client";
import type { HermesEvent } from "../../../src/cerebrum/hermes-event-types";

const HERMES_URL = process.env.HERMES_TEST_URL ?? "http://localhost:8643";
const HERMES_KEY = process.env.HERMES_TEST_KEY ?? "";

const SKIP_REASON = (() => {
  if (!process.env.OPENROUTER_API_KEY) return "OPENROUTER_API_KEY not set";
  if (!HERMES_KEY) return "HERMES_TEST_KEY not set";
  return null;
})();

async function pingHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${HERMES_URL}/health`, {
      headers: { Authorization: `Bearer ${HERMES_KEY}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe.skipIf(SKIP_REASON !== null)("HermesClient e2e against live container", () => {
  it("sanity: /health is reachable", async () => {
    const ok = await pingHealth();
    if (!ok) {
      throw new Error(
        `Hermes not reachable at ${HERMES_URL}. Start it with: cd deploy/docker && docker compose up -d hermes-alice`,
      );
    }
  });

  it("completes a simple turn, emits text deltas and completion", async () => {
    const binding: HermesProfileBinding = {
      userId: "test",
      url: HERMES_URL,
      apiKey: HERMES_KEY,
      conversationId: null,
    };
    const client = new HttpHermesClient(binding);
    const ctrl = new AbortController();
    const events: HermesEvent[] = [];
    for await (const e of client.dispatch(
      {
        userId: "test",
        cycleId: `e2e-${Date.now()}`,
        userMessage: "Say exactly: OK",
        conversationId: null,
        maxOutputTokens: 32,
      },
      ctrl.signal,
      { bargedIn: () => false },
    )) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("created");
    expect(types).toContain("text.delta");
    expect(types[types.length - 1]).toBe("completed");
  }, 60_000);

  it("SSE disconnect on abort does not throw", async () => {
    const binding: HermesProfileBinding = {
      userId: "test",
      url: HERMES_URL,
      apiKey: HERMES_KEY,
      conversationId: null,
    };
    const client = new HttpHermesClient(binding);
    const ctrl = new AbortController();
    const events: HermesEvent[] = [];
    const gen = client.dispatch(
      {
        userId: "test",
        cycleId: `e2e-abort-${Date.now()}`,
        userMessage: "Count from 1 to 1000 slowly with explanations.",
        conversationId: null,
        maxOutputTokens: 1024,
      },
      ctrl.signal,
      { bargedIn: () => false },
    );
    const first = await gen.next();
    if (first.value) events.push(first.value);
    ctrl.abort();
    for await (const e of gen) events.push(e);
    expect(events.length).toBeGreaterThan(0);
  }, 30_000);
});
