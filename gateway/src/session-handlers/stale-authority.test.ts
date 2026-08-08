// SECURITY BOUNDARY — the LET-THROUGH half of the configure gate.
//
// The refusals are pinned at the seam that matters (`ws-handlers-routing.test.
// ts`), driving a real `session.configure` frame through the router. What is
// left is the other direction, and it is the half a fail-closed gate gets
// wrong: a socket whose authority still matches the record must pass
// untouched, and a socket that has not authenticated at all must not be closed
// by a gate that is not its governor.

import type { ServerWebSocket } from "bun";
import { describe, expect, it } from "vitest";
import { createUserPrincipal } from "../identity/user-principal.js";
import { NEVER_REVOKED } from "../user-auth/credential-floor.js";
import type { UserRecord } from "../user-auth/types.js";
import { refuseStaleAuthority } from "./stale-authority.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

const USER_ID = "u_deadbeef";
const HOUR_MS = 3_600_000;

interface FakeSocket {
  readonly sent: string[];
  readonly closes: number[];
  readonly ws: ServerWebSocket<SessionData>;
}

function authedSocket(): FakeSocket {
  const data = createEmptySessionData();
  data.sessionId = "conn-1";
  data.authState = "authed";
  data.principal = createUserPrincipal(USER_ID, "adult", "home");
  data.tokenIssuedAtMs = Date.now() - HOUR_MS;
  data.tokenExpiresAtMs = Date.now() + HOUR_MS;
  return socketOver(data);
}

function socketOver(data: SessionData): FakeSocket {
  const sent: string[] = [];
  const closes: number[] = [];
  const ws = {
    data,
    send: (text: string) => {
      sent.push(text);
      return text.length;
    },
    close: (code: number) => {
      closes.push(code);
    },
    getBufferedAmount: () => 0,
  };
  return { sent, closes, ws: ws as unknown as ServerWebSocket<SessionData> };
}

function storeReturning(record: UserRecord | null) {
  return { get: async () => ({ ok: true as const, value: record }) };
}

const MATCHING_RECORD: UserRecord = {
  userId: USER_ID,
  displayName: "Dee",
  pinHash: "$argon2id$fake",
  role: "adult",
  avatarTint: "terra",
  createdAt: "2026-01-01T00:00:00.000Z",
  credentialsValidFrom: NEVER_REVOKED,
};

describe("refuseStaleAuthority", () => {
  it("lets a socket whose authority still matches the record through untouched", async () => {
    const socket = authedSocket();

    const reason = await refuseStaleAuthority(socket.ws, storeReturning(MATCHING_RECORD));

    expect(reason).toBeNull();
    expect(socket.closes).toEqual([]);
    expect(socket.sent).toEqual([]);
  });

  // A never-revoked account's floor is the epoch and a legacy one's is its
  // `createdAt`; neither may refuse a token minted after it. Getting this wrong
  // logs out the whole household on the frame every client sends first.
  it("lets a socket through when the floor predates its token", async () => {
    const socket = authedSocket();
    const legacyFloor = new Date(Date.now() - 2 * HOUR_MS).toISOString();

    const reason = await refuseStaleAuthority(
      socket.ws,
      storeReturning({ ...MATCHING_RECORD, credentialsValidFrom: legacyFloor }),
    );

    expect(reason).toBeNull();
    expect(socket.closes).toEqual([]);
  });

  // The auth gate governs an unauthenticated socket, not this. Closing one here
  // would eject a connection mid-handshake over a record it has not claimed.
  it("does not close a socket that has not authenticated", async () => {
    const socket = socketOver(createEmptySessionData());

    const reason = await refuseStaleAuthority(socket.ws, storeReturning(null));

    expect(reason).toBeNull();
    expect(socket.closes).toEqual([]);
  });
});
