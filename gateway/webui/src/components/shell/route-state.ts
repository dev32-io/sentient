import type { TopbarRoute } from "./topbar.tsx";

export const ROUTE_STORAGE_KEY = "sentient:route";
export const PENDING_SESSION_KEY = "sentient:pendingSessionId";

type RouteStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): RouteStorage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

export function loadStoredRoute(storage: Pick<RouteStorage, "getItem"> | undefined = browserStorage()): TopbarRoute {
  if (!storage) return "chat";
  try {
    const saved = storage.getItem(ROUTE_STORAGE_KEY);
    return saved === "settings" || saved === "calendar" ? saved : "chat";
  } catch {
    return "chat";
  }
}

export function loadPendingSession(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = (() => {
    try {
      return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
    } catch {
      return undefined;
    }
  })(),
): string | null {
  if (!storage) return null;
  try {
    const query = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("sessionId");
    if (query && query.length <= 200) {
      storage.setItem(PENDING_SESSION_KEY, query);
      return query;
    }
    return storage.getItem(PENDING_SESSION_KEY);
  } catch {
    return null;
  }
}

export function clearPendingSession(
  storage: Pick<Storage, "removeItem"> | undefined = (() => {
    try {
      return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
    } catch {
      return undefined;
    }
  })(),
): void {
  try {
    storage?.removeItem(PENDING_SESSION_KEY);
  } catch {
    /* navigation remains safe without storage */
  }
  if (typeof history !== "undefined" && typeof location !== "undefined") {
    const url = new URL(location.href);
    url.searchParams.delete("sessionId");
    history.replaceState(history.state, "", url);
  }
}

export function storeRoute(
  route: TopbarRoute,
  storage: Pick<RouteStorage, "setItem"> | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ROUTE_STORAGE_KEY, route);
  } catch {
    // Browsers may disable session storage. Navigation still works in memory.
  }
}
