import { createLogger } from "@sentient/web-sdk";
import { type ApiHttpError, bearerHeaders, handleFetch, jsonHeaders } from "./_helpers";

const log = createLogger(["sentient", "webui", "auth", "api"]);

// ---------------------------------------------------------------------------
// Types — match the gateway auth handler response shapes exactly
// ---------------------------------------------------------------------------

export interface AuthUser {
  userId: string;
  displayName: string;
  isAdmin: boolean;
  avatarTint: string;
}

export interface PublicUser {
  userId: string;
  displayName: string;
  avatarTint: string;
}

export type AuthApiError = ApiHttpError;

type Result<T> = { ok: true; value: T } | { ok: false; error: AuthApiError };

// ---------------------------------------------------------------------------
// Auth API factory
// ---------------------------------------------------------------------------

export interface AuthApiConfig {
  baseUrl?: string;
}

export interface AuthApi {
  setup(input: { userId: string; displayName: string; pin: string }): Promise<
    Result<{ token: string; user: AuthUser }>
  >;
  listUsers(): Promise<Result<PublicUser[]>>;
  login(input: { userId: string; pin: string }): Promise<Result<{ token: string; user: AuthUser }>>;
  me(token: string): Promise<Result<{ token: string; user: AuthUser }>>;
  logout(token: string): Promise<Result<{ ok: boolean }>>;
  updateMe(token: string, input: { displayName: string }): Promise<Result<{ token: string; user: AuthUser }>>;
  changePin(token: string, input: { currentPin: string; newPin: string }): Promise<Result<{ ok: true }>>;
}

export function createAuthApi(config?: AuthApiConfig): AuthApi {
  const base = config?.baseUrl ?? "";

  return {
    async setup(input) {
      log.debug("setup", { userId: input.userId });
      return handleFetch<{ token: string; user: AuthUser }>(
        fetch(`${base}/api/v1/auth/setup`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify(input),
        }),
      );
    },

    async listUsers() {
      log.debug("listUsers");
      return handleFetch<PublicUser[]>(fetch(`${base}/api/v1/auth/users`, { method: "GET" }));
    },

    async login(input) {
      log.debug("login", { userId: input.userId });
      return handleFetch<{ token: string; user: AuthUser }>(
        fetch(`${base}/api/v1/auth/login`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify(input),
        }),
      );
    },

    async me(token) {
      log.debug("me");
      return handleFetch<{ token: string; user: AuthUser }>(
        fetch(`${base}/api/v1/auth/me`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },

    async logout(token) {
      log.debug("logout");
      return handleFetch<{ ok: boolean }>(
        fetch(`${base}/api/v1/auth/logout`, {
          method: "POST",
          headers: bearerHeaders(token),
        }),
      );
    },

    async updateMe(token, input) {
      log.debug("updateMe", { displayName: input.displayName });
      return handleFetch<{ token: string; user: AuthUser }>(
        fetch(`${base}/api/v1/auth/me`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify(input),
        }),
      );
    },

    async changePin(token, input) {
      log.debug("changePin");
      return handleFetch<{ ok: true }>(
        fetch(`${base}/api/v1/auth/me/pin`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify(input),
        }),
      );
    },
  };
}
