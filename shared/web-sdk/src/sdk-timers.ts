// ---------------------------------------------------------------------------
// sdk-timers — auth and session-ready timeout management for SentientSDK
// ---------------------------------------------------------------------------

const AUTH_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 10_000;

export interface SdkTimerCallbacks {
  onAuthTimeout(): void;
  onReadyTimeout(): void;
}

export interface SdkTimers {
  startAuthTimeout(reject: (err: Error) => void): void;
  startReadyTimeout(reject: (err: Error) => void): void;
  clearAuthTimer(): void;
  clearReadyTimer(): void;
  clearAll(): void;
}

export function createSdkTimers(callbacks: SdkTimerCallbacks): SdkTimers {
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearAuthTimer(): void {
    if (authTimer !== null) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  }

  function clearReadyTimer(): void {
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  return {
    startAuthTimeout(reject: (err: Error) => void): void {
      authTimer = setTimeout(() => {
        authTimer = null;
        callbacks.onAuthTimeout();
        reject(new Error("Auth timeout"));
      }, AUTH_TIMEOUT_MS);
    },

    startReadyTimeout(reject: (err: Error) => void): void {
      readyTimer = setTimeout(() => {
        readyTimer = null;
        callbacks.onReadyTimeout();
        reject(new Error("Session ready timeout"));
      }, READY_TIMEOUT_MS);
    },

    clearAuthTimer,
    clearReadyTimer,
    clearAll(): void {
      clearAuthTimer();
      clearReadyTimer();
    },
  };
}
