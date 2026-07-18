import type { HermesConfig } from "@sentient/config";
import type { UserPortStore } from "./admin/user-port-store.js";
import type { HermesProfileBinding } from "./cerebrum/hermes-client.js";
import { getLog } from "./logging/logger.js";
import { assertUserId } from "./user-auth/user-id.js";

const log = getLog(["sentient", "gateway", "session-router"]);

/** Maps sessions to per-user Hermes profile bindings with conversation persistence. */
export interface SessionRouter {
  /** Bind a session to a user's Hermes worker. UserId is required — every
   *  session is associated with the auth-derived userId from ws-auth-gate.
   *  surfaceId identifies the transport's surface for logging; the
   *  conversation anchor itself lives on PersonSession, not here. */
  bind(sessionId: string, userId: string, surfaceId: string): Promise<HermesProfileBinding>;
  /** Release a session binding when WS closes. */
  release(sessionId: string): void;
  /** Rebind a session to a different user (Phase 1.7 `identify_user`). */
  rebind(sessionId: string, newUserId: string): Promise<HermesProfileBinding>;
  /** Current binding for a session (read-only lookup). conversationId is
   *  always null here — the conversation anchor lives on PersonSession, not
   *  SessionRouter. */
  get(sessionId: string): HermesProfileBinding | null;
  /** Find the most recent session bound to a given userId. */
  findActiveSessionFor(userId: string): string | null;
}

interface InternalBinding {
  sessionId: string;
  userId: string;
  url: string;
  apiKey: string;
  surfaceId: string;
  boundAt: number;
}

export interface SessionRouterDeps {
  hermes: HermesConfig;
  userPortStore: UserPortStore;
  apiKeyResolver: () => string;
}

export function createSessionRouter(deps: SessionRouterDeps): SessionRouter {
  const bindings = new Map<string, InternalBinding>();
  let bindSeq = 0;

  async function resolveBinding(userId: string): Promise<HermesProfileBinding> {
    assertUserId(userId);
    const port = await deps.userPortStore.resolvePort(userId);
    if (port === null) {
      throw new Error(`session-router: no port binding for userId="${userId}"`);
    }
    const url = renderWorkerUrl(deps.hermes.worker.url_template, port);
    return {
      userId,
      url,
      apiKey: deps.apiKeyResolver(),
      conversationId: null,
    };
  }

  return {
    async bind(sessionId, userId, surfaceId) {
      const b = await resolveBinding(userId);
      const rec: InternalBinding = {
        sessionId,
        userId: b.userId,
        url: b.url,
        apiKey: b.apiKey,
        surfaceId,
        boundAt: ++bindSeq,
      };
      bindings.set(sessionId, rec);
      log.info("bind", {
        sessionId,
        userId: b.userId,
        url: b.url,
        surfaceId,
        boundAt: rec.boundAt,
      });
      return b;
    },

    release(sessionId) {
      const prior = bindings.get(sessionId);
      bindings.delete(sessionId);
      log.info("release", {
        sessionId,
        priorUserId: prior?.userId ?? null,
        priorSurfaceId: prior?.surfaceId ?? null,
        remainingBindings: bindings.size,
      });
    },

    async rebind(sessionId, newUserId) {
      // NOTE: this used to also call anchors.delete(prior.surfaceId) to drop
      // the session's conversation anchor on identity switch, forcing a fresh
      // Hermes chain. That anchor map moved to PersonSession, and this router
      // has no PersonSession/surfaceId handle to re-home the call onto — so
      // "fresh chain on identify_user" is dropped here as a known follow-up,
      // to be wired on the identify_user tool path instead (which does have
      // both handles) rather than reintroduced on SessionRouter.
      const prior = bindings.get(sessionId);
      if (!prior) {
        log.warn("rebind.unknown-session", { sessionId, newUserId, reason: "no prior bind" });
        throw new Error(`rebind: unknown session ${sessionId}`);
      }
      const b = await resolveBinding(newUserId);
      const rec: InternalBinding = {
        sessionId,
        userId: b.userId,
        url: b.url,
        apiKey: b.apiKey,
        surfaceId: prior.surfaceId,
        boundAt: ++bindSeq,
      };
      bindings.set(sessionId, rec);
      log.info("rebind", {
        sessionId,
        priorUserId: prior.userId,
        newUserId: b.userId,
        url: b.url,
        surfaceId: prior.surfaceId,
        boundAt: rec.boundAt,
      });
      return b;
    },

    get(sessionId) {
      const b = bindings.get(sessionId) ?? null;
      if (b === null) return null;
      return { userId: b.userId, url: b.url, apiKey: b.apiKey, conversationId: null };
    },

    findActiveSessionFor(userId) {
      let latest: InternalBinding | null = null;
      for (const b of bindings.values()) {
        if (b.userId === userId && (!latest || b.boundAt > latest.boundAt)) {
          latest = b;
        }
      }
      return latest?.sessionId ?? null;
    },
  };
}

/** `http://host:{port}/...` → `http://host:8651/...`. */
export function renderWorkerUrl(template: string, port: number): string {
  return template.replaceAll("{port}", String(port));
}
