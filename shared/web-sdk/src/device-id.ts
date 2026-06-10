// ---------------------------------------------------------------------------
// device-id — stable per-browser deviceId persisted to localStorage.
//
// Used in `session.configure` so the gateway can identify the client device
// across reconnects and replay missed frames to the right device (the resume
// request rides inside the same configure frame).
//
// Falls back to an in-memory UUID when localStorage is unavailable (SSR, tests,
// or when storage is disabled by browser policy). The in-memory fallback
// generates a new id on each page load — stable enough for reconnects within
// a tab, but not across reloads without storage.
// ---------------------------------------------------------------------------

import { createLogger } from "./logger.ts";

const log = createLogger(["sentient", "web-sdk", "device-id"]);

const DEVICE_ID_KEY = "sentient.deviceId";

// In-memory fallback — initialized lazily on first call to getOrCreateDeviceId().
let memoryFallbackId: string | null = null;

function readLocalStorage(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
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
 * Get or create a stable deviceId for this browser. The id is persisted in
 * localStorage under `sentient.deviceId` so it survives page reloads and
 * reconnects. Falls back to an in-memory UUID when localStorage is
 * unavailable.
 */
export function getOrCreateDeviceId(): string {
  const stored = readLocalStorage(DEVICE_ID_KEY);
  if (stored !== null && stored !== "") {
    return stored;
  }

  // Not yet persisted — generate and store.
  if (memoryFallbackId !== null) {
    // localStorage unavailable but we already generated one this session.
    return memoryFallbackId;
  }

  const id = generateUUID();
  writeLocalStorage(DEVICE_ID_KEY, id);

  // If localStorage write succeeded, readLocalStorage will return it next time.
  // If not, cache in memory so this call is stable within the same page load.
  const check = readLocalStorage(DEVICE_ID_KEY);
  if (check === null || check === "") {
    memoryFallbackId = id;
    log.debug("device-id.memory-fallback", { id });
  } else {
    log.debug("device-id.persisted", { id });
  }

  return id;
}

/** Test helper — reset the in-memory fallback between tests. */
export function _resetMemoryFallbackForTests(): void {
  memoryFallbackId = null;
}
