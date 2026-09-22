import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { AUTH_STORAGE_KEY, AUTH_TIMEOUT_MS } from "../constants.js";
import type { AuthApi, AuthApiError, AuthUser } from "../services/auth-api.js";
import type { AuthState } from "../types.js";

const log = createLogger(["sentient", "webui", "auth", "context"]);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthApiError };

export interface AuthLoginOptions {
  /** Resolve after client-owned verification feedback has been presented. */
  beforeCommit?: () => void | Promise<void>;
  /** Cancels an uncommitted login; never clears an already committed session. */
  signal?: AbortSignal;
}

type AuthContextValue = AuthState & {
  login(input: { userId: string; pin: string }, options?: AuthLoginOptions): Promise<AuthResult<{ token: string }>>;
  setup(input: { userId: string; displayName: string; pin: string }): Promise<AuthResult<{ token: string }>>;
  logout(): Promise<void>;
  updateUser(user: AuthUser): void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

interface StoredAuth {
  token: string;
  user: AuthUser | null;
}

const LEGACY_AUTH_IDENTITY_STORAGE_KEY = `${AUTH_STORAGE_KEY}.identity`;

/**
 * Per-tab auth storage. sessionStorage is primary so two browser tabs in the
 * same origin can hold different accounts (one Kevin, one veronica).
 * localStorage is a "last login on this device" hint: fresh tabs seed
 * sessionStorage from it so the user isn't forced to re-PIN on every new tab,
 * but never *overrides* a tab that already has a logged-in session.
 */
function validUser(value: unknown): value is AuthUser {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  const role = user.role;
  return typeof user.userId === "string" && typeof user.displayName === "string" &&
    typeof user.isAdmin === "boolean" && typeof user.avatarTint === "string" &&
    (role === undefined || role === "admin" || role === "adult" || role === "child" || role === "guest") &&
    (user.calendarCapabilities === undefined ||
      (typeof user.calendarCapabilities === "object" && user.calendarCapabilities !== null));
}

function readFromStore(store: Storage): StoredAuth | null {
  const raw = store.getItem(AUTH_STORAGE_KEY);
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as Record<string, unknown>).token !== "string")
    return null;
  const user = (parsed as Record<string, unknown>).user;
  return { token: (parsed as { token: string }).token, user: validUser(user) ? user : null };
}

function readStoredAuth(): StoredAuth | null {
  try {
    // Presence of a session record owns this tab, even when legacy/ambiguous.
    if (sessionStorage.getItem(AUTH_STORAGE_KEY) !== null) return readFromStore(sessionStorage);
    const local = readFromStore(localStorage);
    if (local) sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(local));
    return local;
  } catch {
    log.warn("storage-read-failed");
    return null;
  }
}

function persistToken(token: string, user: AuthUser): void {
  const payload = JSON.stringify({ token, user });
  sessionStorage.setItem(AUTH_STORAGE_KEY, payload);
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, payload);
    localStorage.removeItem(LEGACY_AUTH_IDENTITY_STORAGE_KEY);
  } catch {
    /* localStorage may be disabled / over quota — sessionStorage suffices */
  }
  sessionStorage.removeItem(LEGACY_AUTH_IDENTITY_STORAGE_KEY);
}

function clearStoredToken(): void {
  // Logout clears THIS tab's session and the device-wide hint. Other tabs
  // keep their sessionStorage and remain logged in until they reload.
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  sessionStorage.removeItem(LEGACY_AUTH_IDENTITY_STORAGE_KEY);
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(LEGACY_AUTH_IDENTITY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Logical cancellation: AuthApi has no transport signal, so late responses are ignored. */
function loginBoundary<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("cancelled")); return; }
    const finish = (callback: () => void) => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new Error("cancelled")));
    const timer = window.setTimeout(() => finish(() => reject(new Error("timeout"))), AUTH_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new Error("cancelled");
      return operation();
    }).then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(new Error("request-failed"))),
    );
  });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface AuthProviderProps {
  api: AuthApi;
  children: ComponentChildren;
}

export function AuthProvider({ api, children }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>({ status: "boot" });
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const pendingLoginRef = useRef<AbortController | null>(null);

  const invalidateLogin = () => {
    generationRef.current += 1;
    pendingLoginRef.current?.abort();
    pendingLoginRef.current = null;
  };

  useEffect(() => () => {
    mountedRef.current = false;
    invalidateLogin();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const generation = generationRef.current;
    const stored = readStoredAuth();

    if (!stored) {
      log.debug("hydrate-no-token");
      if (mountedRef.current) setState({ status: "anonymous" });
      return;
    }

    log.debug("hydrate-validating");
    (async () => {
      const result = await api.me(stored.token);
      if (!mountedRef.current || generation !== generationRef.current) return;

      if (!result.ok) {
        if (result.error.status === 0 && stored.user) {
          log.warn("hydrate-offline", { userId: stored.user.userId });
          setState({ status: "authenticated", token: stored.token, user: stored.user });
          return;
        }
        log.warn("hydrate-token-invalid", { code: result.error.code });
        clearStoredToken();
        setState({ status: "anonymous" });
        return;
      }

      log.debug("hydrate-success", { userId: result.value.user.userId });
      persistToken(result.value.token, result.value.user);
      setState({
        status: "authenticated",
        token: result.value.token,
        user: result.value.user,
      });
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [api]);

  const login = async (input: { userId: string; pin: string }, options?: AuthLoginOptions) => {
    invalidateLogin();
    const generation = generationRef.current;
    const controller = new AbortController();
    pendingLoginRef.current = controller;
    const cancel = () => controller.abort();
    options?.signal?.addEventListener("abort", cancel, { once: true });
    if (options?.signal?.aborted) cancel();
    const current = () => mountedRef.current && generation === generationRef.current;
    const cancelled = { ok: false as const, error: { status: 0, code: "login-cancelled" } };

    if (current() && !controller.signal.aborted) setState({ status: "authenticating" });
    try {
      const result = await loginBoundary(() => api.login(input), controller.signal);
      if (!current() || controller.signal.aborted) return cancelled;
      if (!result.ok) {
        log.warn("login-failed", { code: result.error.code });
        setState({ status: "anonymous" });
        return { ok: false as const, error: result.error };
      }

      await loginBoundary(() => options?.beforeCommit?.(), controller.signal);
      // Presentation completion is not authorization to persist a stale attempt.
      if (!current() || controller.signal.aborted) return cancelled;
      persistToken(result.value.token, result.value.user);
      pendingLoginRef.current = null;
      setState({ status: "authenticated", token: result.value.token, user: result.value.user });
      log.debug("login-success", { userId: result.value.user.userId });
      return { ok: true as const, value: { token: result.value.token } };
    } catch {
      if (!current()) return cancelled;
      setState({ status: "anonymous" });
      if (controller.signal.aborted) return cancelled;
      log.warn("login-request-failed");
      return { ok: false as const, error: { status: 0, code: "network-error" } };
    } finally {
      options?.signal?.removeEventListener("abort", cancel);
      if (pendingLoginRef.current === controller) {
        pendingLoginRef.current = null;
        if (current() && controller.signal.aborted) setState({ status: "anonymous" });
      }
    }
  };

  const setup = async (input: { userId: string; displayName: string; pin: string }) => {
    invalidateLogin();
    const generation = generationRef.current;
    setState({ status: "authenticating" });
    const result = await api.setup(input);
    if (!mountedRef.current || generation !== generationRef.current) {
      return { ok: false as const, error: { status: 0, code: "login-cancelled" } };
    }

    if (!result.ok) {
      log.warn("setup-failed", { code: result.error.code });
      setState({ status: "anonymous" });
      return { ok: false as const, error: result.error };
    }

    log.debug("setup-success", { userId: result.value.user.userId });
    persistToken(result.value.token, result.value.user);
    setState({
      status: "authenticated",
      token: result.value.token,
      user: result.value.user,
    });
    return { ok: true as const, value: { token: result.value.token } };
  };

  const logout = async () => {
    const token = state.status === "authenticated" ? state.token : null;
    invalidateLogin();
    clearStoredToken();
    setState({ status: "anonymous" });
    log.debug("logout");
    if (!token) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    try {
      await api.logout(token, controller.signal);
    } catch {
      /* local logout already complete; server logout is best effort */
    } finally {
      window.clearTimeout(timer);
      controller.abort();
    }
  };

  const updateUser: AuthContextValue["updateUser"] = (user) => {
    setState((prev) => {
      if (prev.status !== "authenticated") return prev;
      persistToken(prev.token, user);
      return { ...prev, user };
    });
  };

  const value: AuthContextValue = { ...state, login, setup, logout, updateUser };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
