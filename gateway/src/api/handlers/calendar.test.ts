import { describe, expect, it } from "bun:test";
import { createCalendarHandler } from "./calendar.js";

const handler = createCalendarHandler({
  tokens: {} as never,
  users: { get: async () => ({ ok: true as const, value: null }) },
  accessManager: {} as never,
});

describe("calendar REST handler", () => {
  it("rejects requests without a bearer token", async () => {
    const response = await handler(new Request("http://localhost/api/v1/calendar/events"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "missing-token", message: "Bearer authentication is required" });
  });
});
