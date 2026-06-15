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
   *  surfaceId keys the conversation anchor: the per-transport sessionId
   *  binding dies on reconnect, but the surface (and its anchored
   *  conversationId) survives the handover. */
  bind(sessionId: string, userId: string, surfaceId: string): Promise<HermesProfileBinding>;
  /** Release a session binding when WS closes. Does NOT drop the surface
   *  anchor — the surface outlives the transport. */
  release(sessionId: string): void;
  /** Rebind a session to a different user (Phase 1.7 `identify_user`). */
  rebind(sessionId: string, newUserId: string): Promise<HermesProfileBinding>;
  /** Current binding for a session (read-only lookup). conversationId is read
   *  off the surface anchor, not the per-session binding. */
  get(sessionId: string): HermesProfileBinding | null;
  /** Anchor a conversationId to a surface after a Hermes turn. Keyed by
   *  surfaceId so the anchor survives transport reconnects on the same
   *  surface. */
  updateConversationId(surfaceId: string, conversationId: string): void;
  /** Drop a surface's conversation anchor when the surface is permanently
   *  reaped (buffer sweep / full teardown). Anchor lifetime == surface
   *  lifetime — prevents unbounded anchor growth as surfaces churn. */
  dropAnchor(surfaceId: string): void;
  /**
   * Clear the conversation anchor on every surface bound to this userId.
   * Called by the apply orchestrator so the next turn starts a fresh Hermes
   * chain that reads the new SOUL.md / config.yaml.
   */
  clearConversationIdForAllSessions(userId: string): void;
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
  // surfaceId → conversationId. Survives transport handover: a new sessionId
  // on the same surface reads the anchor set by the prior transport.
  const anchors = new Map<string, string>();
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
      // Delete ONLY the per-transport binding. The surface anchor is keyed by
      // surfaceId and outlives the transport — a reconnect on the same surface
      // must still read the conversationId set by the released transport.
      bindings.delete(sessionId);
      log.info("release", {
        sessionId,
        priorUserId: prior?.userId ?? null,
        priorSurfaceId: prior?.surfaceId ?? null,
        priorConversationId: prior ? (anchors.get(prior.surfaceId) ?? null) : null,
        remainingBindings: bindings.size,
      });
    },

    async rebind(sessionId, newUserId) {
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
      // The surface now belongs to a different user — drop the prior anchor so
      // the next turn starts a fresh Hermes chain under the new identity.
      anchors.delete(prior.surfaceId);
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
      return { userId: b.userId, url: b.url, apiKey: b.apiKey, conversationId: anchors.get(b.surfaceId) ?? null };
    },

    updateConversationId(surfaceId, conversationId) {
      const prev = anchors.get(surfaceId) ?? null;
      // Surface-keyed: the anchor lands even when the originating transport was
      // already released (the surface key survives the handover).
      anchors.set(surfaceId, conversationId);
      log.debug("updateConversationId", {
        surfaceId,
        prevConversationId: prev,
        nextConversationId: conversationId,
      });
    },

    dropAnchor(surfaceId) {
      const prior = anchors.get(surfaceId) ?? null;
      if (prior === null) return;
      anchors.delete(surfaceId);
      log.debug("dropAnchor", { surfaceId, priorConversationId: prior });
    },

    clearConversationIdForAllSessions(userId) {
      let cleared = 0;
      // Collect this user's surfaces from the live bindings, then drop each
      // surface anchor. Anchors are keyed by surfaceId, so we go through the
      // bindings to find which surfaces belong to this userId.
      for (const b of bindings.values()) {
        if (b.userId !== userId) continue;
        const priorConversationId = anchors.get(b.surfaceId) ?? null;
        if (priorConversationId === null) continue;
        log.info("conversation.cleared", {
          sessionId: b.sessionId,
          userId,
          surfaceId: b.surfaceId,
          priorConversationId,
          reason: "apply",
        });
        anchors.delete(b.surfaceId);
        cleared++;
      }
      log.debug("clearConversationIdForAllSessions.done", { userId, cleared });
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
