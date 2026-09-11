import { goldenScheduleWireFixtures } from "@sentient/protocol";
import { describe, expect, it, vi } from "vitest";
import { createSchedulesApi } from "./schedules-api.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("schedules API boundary", () => {
  it("sends revisioned mutations and accepts only frozen response shapes", async () => {
    const schedule = goldenScheduleWireFixtures.resolvedOnce;
    const fetch = vi.fn().mockResolvedValue(json({ schedule: { ...schedule, revision: 2, enabled: false } }));
    const api = createSchedulesApi({ fetch });
    const result = await api.patch("token", schedule.scheduleId, { expectedRevision: 1, changes: { enabled: false } });
    expect(result).toMatchObject({ ok: true, value: { revision: 2, enabled: false } });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/schedules/sch_once",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ expectedRevision: 1, changes: { enabled: false } }),
      }),
    );
  });

  it("surfaces typed retryability and rejects malformed success bodies", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: "conflict", message: "changed", retryable: false } }, 409))
      .mockResolvedValueOnce(json({ schedules: [{ message: "missing identity" }] }));
    const api = createSchedulesApi({ fetch });
    expect(await api.list("token")).toMatchObject({ ok: false, error: { code: "conflict", retryable: false } });
    expect(await api.list("token")).toMatchObject({ ok: false, error: { code: "invalid-response" } });
  });

  it("reload reflects server removal of a consumed one-time entry", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ schedules: [goldenScheduleWireFixtures.resolvedOnce] }))
      .mockResolvedValueOnce(json({ schedules: [] }));
    const api = createSchedulesApi({ fetch });
    const before = await api.list("token");
    const after = await api.list("token");
    expect(before.ok && before.value.schedules).toHaveLength(1);
    expect(after.ok && after.value.schedules).toHaveLength(0);
  });
});
