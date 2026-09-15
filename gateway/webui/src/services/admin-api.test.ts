import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApi } from "./admin-api.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin APNs API", () => {
  it("sends one JSON replacement with bearer authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      private_key_p8: "private-key-contents",
      key_id: "ABCDEFGHIJ",
      team_id: "1234567890",
    };

    await expect(
      createAdminApi({ baseUrl: "https://gateway.test" }).setApnsCredentials("token", input),
    ).resolves.toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://gateway.test/api/v1/admin/secrets/push/apns", {
      method: "PUT",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: expect.any(AbortSignal),
    });
  });

  it("applies saved credentials with a bodyless request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, transport: "running" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(createAdminApi().applyApnsCredentials("token")).resolves.toEqual({
      ok: true,
      value: { ok: true, transport: "running" },
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/v1/admin/secrets/push/apns/apply", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it.each([
    ["save", 15_000],
    ["apply", 360_000],
  ] as const)("aborts a stalled APNs %s request after its bounded wait", async (operation, timeoutMs) => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init.signal) throw new Error("missing request signal");
          const signal = init.signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = createAdminApi();

    const request =
      operation === "save"
        ? api.setApnsCredentials("token", {
            private_key_p8: "private-key-contents",
            key_id: "ABCDEFGHIJ",
            team_id: "1234567890",
          })
        : api.applyApnsCredentials("token");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(timeoutMs);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(controller.signal);
    controller.abort(new DOMException("Timed out", "TimeoutError"));

    await expect(request).resolves.toEqual({
      ok: false,
      error: { status: 0, code: "network-error" },
    });
  });
});
