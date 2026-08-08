// SECURITY BOUNDARY — revoking an account's credentials kicks it off the wire.
//
// Layer 1 (the credential floor, user-auth/credential-floor.ts) is what makes a
// revocation authoritative: the token stops validating at every one of the 17
// `validate()` call sites. But a WebSocket is validated ONCE, at connect, so
// layer 1 alone leaves the demoted account's live socket serving until it
// happens to reconnect. This module is layer 2 — the immediacy half.
//
// The property under test is BLAST RADIUS. A revocation must close exactly the
// target account's windows and touch nobody else's: the household shares one
// gateway, and a role change for one member that dropped everyone would be a
// self-inflicted outage.

import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { createSessionManager } from "../auth/session-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { WS_CLOSE_POLICY } from "./credential-lifetime.js";
import { createCredentialRevoker } from "./credential-revocation.js";
import { type SessionHandles, createSessionRegistry } from "./session-registry.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

const ADA = "u_aaaaaaaa";
const GRACE = "u_bbbbbbbb";

/** The code all three clients already classify as a TERMINAL auth failure, so
 *  a kicked window shows its login screen instead of retrying forever. */
const REVOKED_CODE = "expired";

/** What a revoked window sees, IN ORDER. */
const EJECTION = [`auth.error:${REVOKED_CODE}`, `close:${WS_CLOSE_POLICY}`];

interface FakeSocket {
  /**
   * ONE ordered log of everything that happened to this socket.
   *
   * Not two arrays. The contract is `auth.error` **then** close — a bare close
   * is indistinguishable from a lost network, and both SDKs would reconnect
   * with the same dead token forever instead of showing the login screen.
   * Recording sends and closes separately makes a close-before-send regression
   * pass, because both still happened.
   */
  readonly events: SocketEvent[];
  readonly ws: ServerWebSocket<SessionData>;
}

type SocketEvent = { kind: "sent"; frame: { type: string; code?: string } } | { kind: "closed"; code: number };

/** A socket authenticated as [userId] — a principal on `ws.data` is what makes
 *  it enumerable, which is the registry's only index into who owns a window. */
function fakeSocket(userId: string, connectionId: string): FakeSocket {
  const events: SocketEvent[] = [];
  const data = createEmptySessionData();
  data.sessionId = connectionId;
  data.authState = "authed";
  data.principal = createUserPrincipal(userId, "adult", "home");
  const ws = {
    data,
    send: (text: string) => {
      events.push({ kind: "sent", frame: JSON.parse(text) as { type: string; code?: string } });
      return text.length;
    },
    close: (code: number) => {
      events.push({ kind: "closed", code });
    },
    getBufferedAmount: () => 0,
  };
  return { events, ws: ws as unknown as ServerWebSocket<SessionData> };
}

const IDLE_HANDLES = {
  runtime: { dispose: () => {} },
  permissions: { denyAll: () => {} },
  work: {
    isTurnInFlight: false,
    hasPendingForegroundTool: false,
    hasOutstandingPrompt: false,
    hasAuxiliaryTaskInFlight: false,
    newestBackgroundTaskStartedAtMs: null,
  },
  dispose: () => {},
} as unknown as SessionHandles;

interface Harness {
  registry: ReturnType<typeof createSessionRegistry>;
  sessions: ReturnType<typeof createSessionManager>;
  revoker: ReturnType<typeof createCredentialRevoker>;
  attach: (socket: FakeSocket, userId: string, sessionId: string) => string;
}

/** A live gateway in miniature: the real registry (which owns the attachment
 *  map the revoker enumerates) and the real session manager (which owns the
 *  per-user connection bookkeeping it drops). Nothing here is a double —
 *  a revocation test against doubles would pin the doubles. */
function harness(): Harness {
  // A policy that never disposes: these cases are about which sockets get
  // closed, not about what a detach does to a session's residency.
  const registry = createSessionRegistry(() => {});
  const sessions = createSessionManager();
  return {
    registry,
    sessions,
    revoker: createCredentialRevoker({ registry, sessions }),
    attach(socket, userId, sessionId) {
      const created = sessions.createSession();
      if (!created.ok) throw new Error(created.error);
      const connectionId = created.value.sessionId;
      socket.ws.data.sessionId = connectionId;
      const bound = sessions.bindUser(connectionId, userId);
      if (!bound.ok) throw new Error(bound.error);
      registry.attach(sessionId, connectionId, socket.ws, () => IDLE_HANDLES);
      return connectionId;
    },
  };
}

/** The full ordered story of one socket's ejection, as one comparable value:
 *  `["auth.error:expired", "close:1008"]`. Order is the contract, so it is
 *  asserted as a sequence rather than as two independent facts. */
function ejectionOf(socket: FakeSocket): string[] {
  return socket.events.map((e) => (e.kind === "sent" ? `${e.frame.type}:${e.frame.code ?? ""}` : `close:${e.code}`));
}

describe("CredentialRevoker", () => {
  it("SECURITY: closes every window of the revoked account and leaves every other account's open", async () => {
    const h = harness();
    const adaLaptop = fakeSocket(ADA, "ada-laptop");
    const adaPhone = fakeSocket(ADA, "ada-phone");
    const gracePhone = fakeSocket(GRACE, "grace-phone");
    h.attach(adaLaptop, ADA, "s_ada_1");
    h.attach(adaPhone, ADA, "s_ada_2");
    h.attach(gracePhone, GRACE, "s_grace_1");

    await h.revoker.revokeUser(ADA, "role-changed");

    expect(ejectionOf(adaLaptop)).toEqual(EJECTION);
    expect(ejectionOf(adaPhone)).toEqual(EJECTION);
    // Untouched: not closed, and not even spoken to.
    expect(ejectionOf(gracePhone)).toEqual([]);
  });

  // WIRE CONTRACT. `auth.error` FIRST, then the close: a bare close is
  // indistinguishable from a lost network and both SDKs would reconnect with
  // the same dead token forever instead of showing the login screen. `expired`
  // is the code all three clients already classify as terminal.
  it("WIRE: a closed window is told `auth.error` code expired before the socket closes 1008", async () => {
    const h = harness();
    const ada = fakeSocket(ADA, "ada-laptop");
    h.attach(ada, ADA, "s_ada_1");

    await h.revoker.revokeUser(ADA, "role-changed");

    expect(ejectionOf(ada)).toEqual([`auth.error:${REVOKED_CODE}`, `close:${WS_CLOSE_POLICY}`]);
  });

  it("SECURITY: drops the revoked account's bound sessions, and only those", async () => {
    const h = harness();
    const ada = fakeSocket(ADA, "ada-laptop");
    const grace = fakeSocket(GRACE, "grace-phone");
    const adaConnectionId = h.attach(ada, ADA, "s_ada_1");
    const graceConnectionId = h.attach(grace, GRACE, "s_grace_1");

    await h.revoker.revokeUser(ADA, "role-changed");

    expect(h.sessions.getSession(adaConnectionId)).toBeUndefined();
    expect(h.sessions.getSession(graceConnectionId)).toBeDefined();
  });

  // The delete path has the identical hole and takes the identical fix:
  // `emitDeleted` was wired only to the MCP host, so a deleted account kept a
  // working session until its token expired.
  it("SECURITY: a deleted user's open window is closed by the same path", async () => {
    const h = harness();
    const ada = fakeSocket(ADA, "ada-laptop");
    h.attach(ada, ADA, "s_ada_1");

    await h.revoker.revokeUser(ADA, "user-deleted");

    expect(ejectionOf(ada)).toEqual(EJECTION);
  });

  it("is a no-op for an account with nothing open", async () => {
    const h = harness();
    const grace = fakeSocket(GRACE, "grace-phone");
    h.attach(grace, GRACE, "s_grace_1");

    await h.revoker.revokeUser(ADA, "role-changed");

    expect(ejectionOf(grace)).toEqual([]);
  });
});
