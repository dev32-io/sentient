import { describe, expect, it, vi } from "vitest";
import {
  PENDING_SESSION_KEY,
  ROUTE_STORAGE_KEY,
  clearPendingSession,
  loadPendingSession,
  loadStoredRoute,
  storeRoute,
} from "./route-state.ts";

describe("shell route session state", () => {
  it("restores only supported routes and defaults unknown values to chat", () => {
    expect(loadStoredRoute({ getItem: () => "calendar" })).toBe("calendar");
    expect(loadStoredRoute({ getItem: () => "settings" })).toBe("settings");
    expect(loadStoredRoute({ getItem: () => "unexpected" })).toBe("chat");
  });

  it("keeps a pending session target across the login route reset and clears it after validation", () => {
    const values = new Map([[PENDING_SESSION_KEY, "session-from-cold-link"]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    expect(loadPendingSession(storage)).toBe("session-from-cold-link");
    clearPendingSession(storage);
    expect(loadPendingSession(storage)).toBeNull();
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
