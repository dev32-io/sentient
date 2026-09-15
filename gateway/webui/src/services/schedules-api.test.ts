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

  it("pages cards and sends encoded single and frozen bulk clear requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ cards: [] }))
      .mockResolvedValueOnce(json({ cleared: true }))
      .mockResolvedValueOnce(json({ cleared: true }));
    const api = createSchedulesApi({ fetch });
    const caller = new AbortController();

    expect(await api.cards("token", "next/page", caller.signal)).toEqual({ ok: true, value: { cards: [] } });
    expect(await api.clearCard("token", "session/one", caller.signal)).toEqual({ ok: true, value: { cleared: true } });
    expect(await api.clearCards("token", ["occ-one", "occ-two"], caller.signal)).toEqual({
      ok: true,
      value: { cleared: true },
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/scheduled-session-cards?cursor=next%2Fpage",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/scheduled-session-cards/session%2Fone",
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/v1/scheduled-session-cards",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ occurrenceIds: ["occ-one", "occ-two"] }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty("body");
    const requestSignal = fetch.mock.calls[0]?.[1]?.signal;
    expect(requestSignal?.aborted).toBe(false);
    caller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects an unacknowledged clear success body", async () => {
    const api = createSchedulesApi({ fetch: vi.fn().mockResolvedValue(json({ cleared: false })) });
    expect(await api.clearCards("token", ["occ-one"])).toMatchObject({
      ok: false,
      error: { code: "invalid-response" },
    });
  });

  it("treats explicit empty bulk targets as a local no-op", async () => {
    const fetch = vi.fn();
    const api = createSchedulesApi({ fetch });

    expect(await api.clearCards("token", [])).toEqual({ ok: true, value: { cleared: true } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
