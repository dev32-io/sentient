// GET /api/v1/sessions and GET /api/v1/sessions/:id/messages (spec §3.5 #3,
// §1; session-model plan task 4).
//
// Three invariants live here, and every one is a security boundary rather
// than a plumbing detail:
//
//   - the route reads the principal off the validated bearer token, NEVER a
//     userId the caller supplies — a query-string userId is ignored, not
//     honoured, so it cannot be used to read another household member's list;
//   - an unauthenticated request is refused outright;
//   - an id absent from the caller's own store 404s exactly like an id that
//     never existed anywhere — distinguishing "not yours" from "not there"
//     would be an enumeration oracle. Because each user's sessions live in a
//     physically separate per-user SQLite file (opened via that user's own
//     capability), this holds for another user's real session id too, not
//     just for a made-up one.
//
// A fourth is pinned because shared/protocol's sessionDraftSchema doc states
// it as a MUST-requirement on this exact task: a draft key is not a session
// id, and the messages route must refuse one rather than look it up.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { type AccessManager, createAccessManager } from "../../access/access-manager.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import { mintDraftKey, mintSessionId } from "../../session-handlers/session-id.js";
import { openSessionStore } from "../../store/session-store.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import { createSessionsHandler } from "./sessions.js";
import type { SessionsHandlerDeps } from "./sessions.js";

const ROOT = "/tmp/sentient-sessions-rest-test";
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let runSeq = 0;
let userSeq = 0;

interface TestUser {
  userId: `u_${string}`;
  token: string;
}

interface Harness {
  handleSessions: (request: Request) => Promise<Response>;
  accessManager: AccessManager;
  makeUser: (label: string) => TestUser;
}

/** Fresh AccessManager over a per-test data root (no test can see another's
 *  rows) plus a fake TokenService mapping issued tokens to userIds. */
function freshHarness(): Harness {
  runSeq += 1;
  const accessManager = createAccessManager({ userDataRoot: `${ROOT}/run-${runSeq}` });
  const tokenToUserId = new Map<string, string>();
  const deps: SessionsHandlerDeps = {
    accessManager,
    tokens: {
      async validate(token: string): Promise<TokenResult<TokenPayload>> {
        const userId = tokenToUserId.get(token);
        if (!userId) return { ok: false, error: "malformed" };
        return { ok: true, value: { userId, isAdmin: false, issuedAt: 0, expiresAt: 9_999_999_999 } };
      },
    },
  };
  return {
    handleSessions: createSessionsHandler(deps),
    accessManager,
    makeUser(label) {
      userSeq += 1;
      const userId = `u_${userSeq.toString(16).padStart(8, "0")}` as `u_${string}`;
      const token = `${label}-token-${userSeq}`;
      tokenToUserId.set(token, userId);
      return { userId, token };
    },
  };
}

function requestAs(user: TestUser, path: string): Request {
  return new Request(`https://x${path}`, { headers: { authorization: `Bearer ${user.token}` } });
}

/** Puts a real session with one entry in [user]'s own store and returns its
 *  id — the state a caller is in when it should be able to see/read it back. */
function seedSession(accessManager: AccessManager, user: TestUser, text: string): string {
  const store = openSessionStore(
    accessManager.grant(createUserPrincipal(user.userId, "adult", "home"), "session-store"),
  );
  const sessionId = mintSessionId();
  store.createSession(sessionId, `mint-${sessionId}`);
  store.append({
    sessionId,
    turnId: "seed-turn",
    kind: "user",
    createdAt: Date.now(),
    text,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
  });
  store.close();
  return sessionId;
}

describe("GET /api/v1/sessions", () => {
  it("SECURITY: an unauthenticated request is refused", async () => {
    const { handleSessions } = freshHarness();
    const res = await handleSessions(new Request("https://x/api/v1/sessions"));
    expect(res.status).toBe(401);
  });

  it("SECURITY: a userId in the request cannot select whose sessions are returned", async () => {
    const { handleSessions, accessManager, makeUser } = freshHarness();
    const ada = makeUser("ada");
    const grace = makeUser("grace");
    const adaSessionIds = new Set([
      seedSession(accessManager, ada, "ada's first chat"),
      seedSession(accessManager, ada, "ada's second chat"),
    ]);
    seedSession(accessManager, grace, "grace's private chat");

    const res = await handleSessions(requestAs(ada, "/api/v1/sessions?userId=u_grace"));
    const body = await res.json();
    expect(body.sessions.every((s: { sessionId: string }) => adaSessionIds.has(s.sessionId))).toBe(true);
    // The `.every` above is vacuously true for an empty list — pin that the
    // handler actually served ada's own sessions rather than refusing/dropping
    // everything, which would pass the line above for the wrong reason.
    expect(body.sessions).toHaveLength(adaSessionIds.size);
  });

  it("returns an empty list rather than an error for a user with no sessions", async () => {
    const { handleSessions, makeUser } = freshHarness();
    const freshUser = makeUser("fresh");
    const body = await (await handleSessions(requestAs(freshUser, "/api/v1/sessions"))).json();
    expect(body.sessions).toEqual([]);
  });

  it("lists sessions newest-updated first, the order the store already produces", async () => {
    const { handleSessions, accessManager, makeUser } = freshHarness();
    const user = makeUser("order");
    const first = seedSession(accessManager, user, "first");
    const second = seedSession(accessManager, user, "second");

    const body = await (await handleSessions(requestAs(user, "/api/v1/sessions"))).json();
    expect(body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([second, first]);
  });
});

describe("GET /api/v1/sessions/:id/messages", () => {
  it("SECURITY: an id absent from the caller's store 404s, same as one that never existed", async () => {
    const { handleSessions, makeUser } = freshHarness();
    const user = makeUser("noone");
    const res = await handleSessions(requestAs(user, `/api/v1/sessions/${mintSessionId()}/messages`));
    expect(res.status).toBe(404);
  });

  it("SECURITY: another user's real session id 404s exactly like an unknown one", async () => {
    const { handleSessions, accessManager, makeUser } = freshHarness();
    const owner = makeUser("owner");
    const intruder = makeUser("intruder");
    const ownerSessionId = seedSession(accessManager, owner, "owner's message");

    const res = await handleSessions(requestAs(intruder, `/api/v1/sessions/${ownerSessionId}/messages`));
    expect(res.status).toBe(404);
  });

  it("SECURITY: a draft key is refused rather than treated as a session id", async () => {
    const { handleSessions, makeUser } = freshHarness();
    const user = makeUser("drafter");
    const res = await handleSessions(requestAs(user, `/api/v1/sessions/${mintDraftKey()}/messages`));
    expect(res.status).toBe(404);
  });

  it("returns the committed feed via the same client projection the live path uses", async () => {
    const { handleSessions, accessManager, makeUser } = freshHarness();
    const user = makeUser("reader");
    const sessionId = seedSession(accessManager, user, "hello from the seed");

    const res = await handleSessions(requestAs(user, `/api/v1/sessions/${sessionId}/messages`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: "user", content: "hello from the seed" });
  });
});
