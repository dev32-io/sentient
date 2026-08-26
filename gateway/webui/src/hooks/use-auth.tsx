import { createContext, type ComponentChildren } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { AUTH_STORAGE_KEY } from "../constants.js";
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
}

/**
 * Per-tab auth storage. sessionStorage is primary so two browser tabs in the
 * same origin can hold different accounts (one Kevin, one veronica).
 * localStorage is a "last login on this device" hint: fresh tabs seed
 * sessionStorage from it so the user isn't forced to re-PIN on every new tab,
 * but never *overrides* a tab that already has a logged-in session.
 */
function readFromStore(store: Storage): string | null {
  try {
    const raw = store.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "token" in parsed) {
      return (parsed as StoredAuth).token;
    }
    return null;
  } catch {
    return null;
  }
}

function readStoredToken(): string | null {
  try {
    const fromSession = readFromStore(sessionStorage);
    if (fromSession) return fromSession;
    const fromLocal = readFromStore(localStorage);
    if (fromLocal) {
      // Seed sessionStorage so subsequent reads in this tab don't fall back
      // to localStorage and accidentally pick up a different account swapped
      // in by another tab mid-session.
      sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: fromLocal }));
      return fromLocal;
    }
    return null;
  } catch {
    log.warn("storage-read-failed");
    return null;
  }
}

function persistToken(token: string): void {
  const payload = JSON.stringify({ token });
  sessionStorage.setItem(AUTH_STORAGE_KEY, payload);
  // Mirror to localStorage so a brand-new tab on this device defaults to the
  // same user. Each tab's sessionStorage takes precedence once it's been set.
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, payload);
  } catch {
    /* localStorage may be disabled / over quota — sessionStorage suffices */
  }
}

function clearStoredToken(): void {
  // Logout clears THIS tab's session and the device-wide hint. Other tabs
  // keep their sessionStorage and remain logged in until they reload.
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* ignore */
  }
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

  useEffect(() => {
    mountedRef.current = true;
    const storedToken = readStoredToken();

    if (!storedToken) {
      log.debug("hydrate-no-token");
      if (mountedRef.current) setState({ status: "anonymous" });
      return;
    }

    log.debug("hydrate-validating", { tokenPreview: storedToken.slice(0, 8) });
    (async () => {
      const result = await api.me(storedToken);
      if (!mountedRef.current) return;

      if (!result.ok) {
        log.warn("hydrate-token-invalid", { code: result.error.code });
        clearStoredToken();
        setState({ status: "anonymous" });
        return;
      }

      log.debug("hydrate-success", { userId: result.value.user.userId });
      persistToken(result.value.token);
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
    setState({ status: "authenticating" });
    const result = await api.login(input);

    if (!result.ok) {
      log.warn("login-failed", { code: result.error.code });
      setState({ status: "anonymous" });
      return { ok: false as const, error: result.error };
    }

    await options?.beforeCommit?.();
    log.debug("login-success", { userId: result.value.user.userId });
    persistToken(result.value.token);
    setState({
      status: "authenticated",
      token: result.value.token,
      user: result.value.user,
    });
    return { ok: true as const, value: { token: result.value.token } };
  };

  const setup = async (input: { userId: string; displayName: string; pin: string }) => {
    setState({ status: "authenticating" });
    const result = await api.setup(input);

    if (!result.ok) {
      log.warn("setup-failed", { code: result.error.code });
      setState({ status: "anonymous" });
      return { ok: false as const, error: result.error };
    }

    log.debug("setup-success", { userId: result.value.user.userId });
    persistToken(result.value.token);
    setState({
      status: "authenticated",
      token: result.value.token,
      user: result.value.user,
    });
    return { ok: true as const, value: { token: result.value.token } };
  };

  const logout = async () => {
    if (state.status === "authenticated") {
      await api.logout(state.token);
    }
    log.debug("logout");
    clearStoredToken();
    setState({ status: "anonymous" });
  };

  const updateUser: AuthContextValue["updateUser"] = (user) => {
    setState((prev) => (prev.status === "authenticated" ? { ...prev, user } : prev));
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