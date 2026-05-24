import { PairingCoordinator } from "../../devices/signal/pairing-coordinator.js";
import { PendingLinks } from "../../devices/signal/pending-links.js";
import { SignalCliClient } from "../../devices/signal/signal-cli-client.js";
import { getLog } from "../../logging/logger.js";
import type { TokenService } from "../../user-auth/token-service.js";

// Shared signal-cli native HTTP daemon sidecar reachable by container name
// on the sentient-internal docker network.
const SIGNAL_CLI_URL = "http://sentient-signal-cli:8080";

const log = getLog(["sentient", "api", "devices"]);

// HTTP status constants
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_INTERNAL = 500;

const BEARER_PREFIX = "Bearer ";

// In-memory per-user coordinator + pending-links registry. Single process,
// per-user mutex pattern mirrors the existing apply-mutex in profile.ts.
const coordinators = new Map<string, PairingCoordinator>();
const pending = new PendingLinks();

export interface DevicesHandlerDeps {
  readonly getUserProfile: (userId: string) => Promise<{
    devices?: { signal?: { paired: boolean; account_masked?: string; linked_at?: string } };
  }>;
  readonly provisionSignalCli: (userId: string) => Promise<void>;
  readonly waitForSignalCliHealth: (userId: string) => Promise<void>;
  readonly finalizePair: (userId: string, account: string) => Promise<void>;
  readonly cleanupOnFail: (userId: string) => Promise<void>;
  readonly unpair: (userId: string) => Promise<void>;
}

async function getOrCreateCoordinator(userId: string, deps: DevicesHandlerDeps): Promise<PairingCoordinator> {
  let coord = coordinators.get(userId);
  if (!coord) {
    // All users share the single signal-cli sidecar at the fixed URL.
    const client = new SignalCliClient(SIGNAL_CLI_URL);
    coord = new PairingCoordinator(userId, {
      provisionSignalCli: () => deps.provisionSignalCli(userId),
      waitForHealth: () => deps.waitForSignalCliHealth(userId),
      finalizePair: (account: string) => deps.finalizePair(userId, account),
      cleanupOnFail: () => deps.cleanupOnFail(userId),
      client,
      now: () => Date.now(),
      // Timer factories are optional — PairingCoordinator defaults to global
      // setInterval / setTimeout / clearInterval / clearTimeout.
    });
    coordinators.set(userId, coord);
    log.debug("coordinator-created", { userId });
  }
  return coord;
}

export async function handleLinkSignal(userId: string, deps: DevicesHandlerDeps): Promise<Response> {
  const coord = await getOrCreateCoordinator(userId, deps);
  try {
    await coord.startPair();
  } catch (err) {
    const msg = String(err);
    if (msg.includes("in progress")) {
      // Stale coordinator stuck mid-flight (e.g. user closed modal without cancelling).
      // Cancel the stale state and retry once so the next click always produces a fresh QR.
      log.warn("link-stale-coordinator-cancelling", { userId, state: coord.state });
      try {
        await coord.cancel();
      } catch (cancelErr) {
        log.warn("link-stale-cancel-failed", { userId, error: String(cancelErr) });
      }
      try {
        await coord.startPair();
      } catch (retryErr) {
        const retryMsg = String(retryErr);
        log.warn("link-retry-failed", { userId, error: retryMsg });
        return Response.json({ error: retryMsg }, { status: HTTP_INTERNAL });
      }
    } else {
      log.warn("link-start-failed", { userId, error: msg });
      return Response.json({ error: msg }, { status: HTTP_INTERNAL });
    }
  }

  const qrDataUrl = coord.getQrDataUrl();
  if (!qrDataUrl) {
    log.warn("link-qr-unavailable", { userId, state: coord.state });
    return Response.json({ error: "link-qr-unavailable", state: coord.state }, { status: HTTP_INTERNAL });
  }

  pending.put({
    userId,
    uri: qrDataUrl,
    expiresAt: coord.expiresAt ?? Date.now() + 5 * 60 * 1000,
    nonce: crypto.randomUUID(),
  });

  log.info("link-started", { userId, expiresAt: coord.expiresAt });
  return Response.json({ qrDataUrl, expiresAt: coord.expiresAt });
}

export async function handleLinkSignalCancel(userId: string, _deps: DevicesHandlerDeps): Promise<Response> {
  const coord = coordinators.get(userId);
  if (coord) {
    await coord.cancel();
    log.info("link-cancelled", { userId });
  }
  pending.clear(userId);
  return Response.json({ ok: true }, { status: HTTP_OK });
}

export async function handleLinkSignalStatus(userId: string, deps: DevicesHandlerDeps): Promise<Response> {
  const coord = coordinators.get(userId);
  if (!coord) {
    const profile = await deps.getUserProfile(userId);
    if (profile.devices?.signal?.paired) {
      return Response.json({
        state: "linked",
        account_masked: profile.devices.signal.account_masked,
      });
    }
    return Response.json({ state: "idle" });
  }
  return Response.json({
    state: coord.state,
    error: coord.error,
  });
}

export async function handleUnlinkSignal(userId: string, deps: DevicesHandlerDeps): Promise<Response> {
  try {
    await deps.unpair(userId);
    coordinators.delete(userId);
    pending.clear(userId);
    log.info("signal-unlinked", { userId });
    return Response.json({ status: "unlinked" });
  } catch (err) {
    log.warn("signal-unlink-failed", { userId, error: String(err) });
    return Response.json({ error: String(err) }, { status: HTTP_INTERNAL });
  }
}

export async function handleListDevices(userId: string, deps: DevicesHandlerDeps): Promise<Response> {
  const profile = await deps.getUserProfile(userId);
  return Response.json({
    platforms: {
      signal: profile.devices?.signal ?? { paired: false },
    },
  });
}

export interface DevicesHandlerFactoryDeps extends DevicesHandlerDeps {
  readonly tokens: Pick<TokenService, "validate">;
}

/** Returns a handler for all `/api/v1/devices*` routes.
 *  Every path requires a valid bearer token; userId is extracted from the token. */
export function createDevicesHandler(deps: DevicesHandlerFactoryDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const header = request.headers.get("Authorization") ?? "";
    if (!header.startsWith(BEARER_PREFIX)) {
      return Response.json({ error: "missing-token" }, { status: HTTP_UNAUTHORIZED });
    }
    const token = header.slice(BEARER_PREFIX.length);
    const valid = await deps.tokens.validate(token);
    if (!valid.ok) {
      log.debug("devices.token-rejected", { reason: valid.error });
      return Response.json({ error: valid.error }, { status: HTTP_UNAUTHORIZED });
    }
    const userId = valid.value.userId;
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/v1/devices/signal/link") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: HTTP_METHOD_NOT_ALLOWED });
      }
      return handleLinkSignal(userId, deps);
    }
    if (pathname === "/api/v1/devices/signal/link/cancel") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: HTTP_METHOD_NOT_ALLOWED });
      }
      return handleLinkSignalCancel(userId, deps);
    }
    if (pathname === "/api/v1/devices/signal/link/status") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: HTTP_METHOD_NOT_ALLOWED });
      }
      return handleLinkSignalStatus(userId, deps);
    }
    if (pathname === "/api/v1/devices/signal/unlink") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: HTTP_METHOD_NOT_ALLOWED });
      }
      return handleUnlinkSignal(userId, deps);
    }
    if (pathname === "/api/v1/devices") {
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: HTTP_METHOD_NOT_ALLOWED });
      }
      return handleListDevices(userId, deps);
    }
    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}
