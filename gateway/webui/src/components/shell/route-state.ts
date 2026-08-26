import type { TopbarRoute } from "./topbar.tsx";

export const ROUTE_STORAGE_KEY = "sentient:route";

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
