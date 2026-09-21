import { renderHook, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInstallState } from "./use-install-state.ts";

const complete = {
  bootstrap_complete: true,
  wizard_cursor: "complete",
  unlock_verified: true,
  installed_version: "1",
  current_version: "1",
};

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("install gate offline fallback", () => {
  it("uses only a prior known-complete result after network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(complete), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const first = renderHook(() => useInstallState());
    await waitFor(() => expect(first.result.current.state?.bootstrap_complete).toBe(true));
    first.unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const offline = renderHook(() => useInstallState());
    await waitFor(() => expect(offline.result.current.loading).toBe(false));
    expect(offline.result.current.offlineComplete).toBe(true);
    expect(offline.result.current.error).toBe(false);
  });

  it("does not use completion cache for an HTTP failure", async () => {
    localStorage.setItem("sentient:install-complete", "true");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    const result = renderHook(() => useInstallState());
    await waitFor(() => expect(result.result.current.loading).toBe(false));
    expect(result.result.current.error).toBe(true);
    expect(result.result.current.offlineComplete).toBe(false);
  });
});
