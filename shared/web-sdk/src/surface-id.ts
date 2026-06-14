// ---------------------------------------------------------------------------
// surface-id — per-TAB surfaceId persisted to sessionStorage.
//
// A "surface" is one chat surface: one browser tab. Unlike deviceId (per-
// browser, localStorage), surfaceId is per-tab: sessionStorage is scoped to a
// single tab and survives reloads within that tab, so two tabs get two distinct
// surfaceIds. Sent in `session.configure` (optional) so the gateway keys the
// ACP wire / resume buffer / replay attachment per surface (2026-06-14 design).
// Falls back to an in-memory UUID when sessionStorage is unavailable (SSR,
// tests, or storage disabled by browser policy).
// ---------------------------------------------------------------------------

import { createLogger } from "./logger.ts";

const log = createLogger(["sentient", "web-sdk", "surface-id"]);

const SURFACE_ID_KEY = "sentient.surfaceId";

// In-memory fallback — initialized lazily on first call to getOrCreateSurfaceId().
let memoryFallbackId: string | null = null;

function readSessionStorage(key: string): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key: string, value: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(key, value);
  } catch {
    /* storage disabled / quota — non-fatal */
  }
}

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Minimal fallback for environments without crypto.randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get or create a per-tab surfaceId. The id is persisted in sessionStorage
 * under `sentient.surfaceId` so it survives reloads within the same tab but
 * differs across tabs. Falls back to an in-memory UUID when sessionStorage is
 * unavailable.
 */
export function getOrCreateSurfaceId(): string {
  const stored = readSessionStorage(SURFACE_ID_KEY);
  if (stored !== null && stored !== "") {
    return stored;
  }

  // Not yet persisted — generate and store.
  if (memoryFallbackId !== null) {
    // sessionStorage unavailable but we already generated one this session.
    return memoryFallbackId;
  }

  const id = generateUUID();
  writeSessionStorage(SURFACE_ID_KEY, id);

  // If sessionStorage write succeeded, readSessionStorage will return it next time.
  // If not, cache in memory so this call is stable within the same page load.
  const check = readSessionStorage(SURFACE_ID_KEY);
  if (check === null || check === "") {
    memoryFallbackId = id;
    log.debug("surface-id.memory-fallback", { id });
  } else {
    log.debug("surface-id.persisted", { id });
  }

  return id;
}

/** Test helper — reset the in-memory fallback between tests. */
export function _resetSurfaceMemoryFallbackForTests(): void {
  memoryFallbackId = null;
}
