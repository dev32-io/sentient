import { describe, expect, it, vi } from "vitest";
import { ROUTE_STORAGE_KEY, loadStoredRoute, storeRoute } from "./route-state.ts";

describe("shell route session state", () => {
  it("restores only supported routes and defaults unknown values to chat", () => {
    expect(loadStoredRoute({ getItem: () => "calendar" })).toBe("calendar");
    expect(loadStoredRoute({ getItem: () => "settings" })).toBe("settings");
    expect(loadStoredRoute({ getItem: () => "unexpected" })).toBe("chat");
  });

  it("persists route changes and tolerates unavailable storage", () => {
    const setItem = vi.fn();
    storeRoute("calendar", { setItem });
    expect(setItem).toHaveBeenCalledWith(ROUTE_STORAGE_KEY, "calendar");
    expect(() =>
      storeRoute("chat", {
        setItem: () => {
          throw new Error("blocked");
        },
      }),
    ).not.toThrow();
  });
});
