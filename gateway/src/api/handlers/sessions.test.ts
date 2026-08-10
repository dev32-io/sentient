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
// Two more are pinned because shared/protocol's sessionDraftSchema doc states
// them as MUST-requirements on this exact task: a draft key is not a session
// id, so the messages route must refuse one rather than look it up, and the
// list route must never let a mint key surface as a sessionId — the only
// column a draft key is ever written to.

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { UserRole } from "@sentient/protocol";
import { type AccessManager, createAccessManager } from "../../access/access-manager.js";
import type { Capability } from "../../access/capability.js";
import { createUserPrincipal } from "../../identity/user-principal.js";
import { mintDraftKey, mintOnFirstMessage, mintSessionId } from "../../session-handlers/session-id.js";
import { openSessionStore } from "../../store/session-store.js";
import { NEVER_REVOKED } from "../../user-auth/credential-floor.js";
import type { TokenPayload, TokenResult, UserRecord } from "../../user-auth/types.js";
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
  /** Every capability the HANDLER minted, in order. Seeding uses the raw
   *  manager, so nothing a test set up itself lands here. */
  grants: Capability[];
  /** Re-role a user in the record store the handler reads. */
  setRole: (user: TestUser, role: UserRole) => void;
  /** Delete a user's record while their token stays valid — the shape a
   *  just-deleted account presents. */
  forgetRecord: (user: TestUser) => void;
}

function recordFor(userId: string, role: UserRole): UserRecord {
  return {
    userId,
    displayName: userId,
    pinHash: "$argon2id$fake",
    role,
    avatarTint: "terra",
    createdAt: "2026-08-07T00:00:00.000Z",
    credentialsValidFrom: NEVER_REVOKED,
  };
}

/** Fresh AccessManager over a per-test data root (no test can see another's
 *  rows) plus a fake TokenService mapping issued tokens to userIds. */
function freshHarness(): Harness {
  runSeq += 1;
  const accessManager = createAccessManager({ userDataRoot: `${ROOT}/run-${runSeq}` });
  const tokenToUserId = new Map<string, string>();
  const records = new Map<string, UserRecord | null>();
  const grants: Capability[] = [];
  const deps: SessionsHandlerDeps = {
    // Wrapped so the ROLE the handler bakes into a capability is observable.
    // `AccessManager.grant` is where a principal becomes authority (L1), so
    // this is the only place the record → capability link can be seen.
    accessManager: {
      userHomeDir: (principal) => accessManager.userHomeDir(principal),
      grant(principal, resource) {
        const cap = accessManager.grant(principal, resource);
        grants.push(cap);
        return cap;
      },
    },
    tokens: {
      async validate(token: string): Promise<TokenResult<TokenPayload>> {
        const userId = tokenToUserId.get(token);
        if (!userId) return { ok: false, error: "malformed" };
        return { ok: true, value: { userId, issuedAt: 0, expiresAt: 9_999_999_999 } };
      },
    },
    // The route resolves the principal's ROLE here, not from the token — see
    // the module header. Every user this harness mints is an ordinary adult
    // until a test says otherwise.
    users: {
      async get(userId: string) {
        return { ok: true as const, value: records.get(userId) ?? null };
      },
    },
    dbFileName: "sessions.db",
  };
  return {
    handleSessions: createSessionsHandler(deps),
    accessManager,
    grants,
    makeUser(label) {
      userSeq += 1;
      const userId = `u_${userSeq.toString(16).padStart(8, "0")}` as `u_${string}`;
      const token = `${label}-token-${userSeq}`;
      tokenToUserId.set(token, userId);
      records.set(userId, recordFor(userId, "adult"));
      return { userId, token };
    },
    setRole(user, role) {
      records.set(user.userId, recordFor(user.userId, role));
    },
    forgetRecord(user) {
      records.set(user.userId, null);
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
    replyId: null,
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

// The route MINTS a `UserPrincipal` and `AccessManager.grant` bakes that
// principal's role into a `Capability` — so this is the site where a stale
// authority claim would become a frozen authority object. Both halves of the
// resolution are pinned: where the role comes from, and what happens when the
// record it comes from is gone.
describe("the principal this route mints", () => {
  it("SECURITY: a token naming a user with no record is refused rather than defaulted", async () => {
    const { handleSessions, makeUser, forgetRecord, grants } = freshHarness();
    const deleted = makeUser("deleted");
    forgetRecord(deleted);

    const res = await handleSessions(requestAs(deleted, "/api/v1/sessions"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "user-not-found" });
    // Fails CLOSED: no capability was minted at all, so there is no defaulted
    // role for anything downstream to act on.
    expect(grants).toHaveLength(0);
  });

  it("SECURITY: the capability's role comes from the record, not from the token", async () => {
    const { handleSessions, makeUser, setRole, grants } = freshHarness();
    const operator = makeUser("operator");
    setRole(operator, "admin");

    await handleSessions(requestAs(operator, "/api/v1/sessions"));

    expect(grants.map((c) => c.role)).toEqual(["admin"]);
  });

  it("SECURITY: a demotion in the record reaches the very next request's capability", async () => {
    const { handleSessions, makeUser, setRole, grants } = freshHarness();
    const demoted = makeUser("demoted");
    setRole(demoted, "admin");
    await handleSessions(requestAs(demoted, "/api/v1/sessions"));

    setRole(demoted, "child");
    await handleSessions(requestAs(demoted, "/api/v1/sessions"));

    // Same token, no refresh, no re-login — the second capability is attenuated.
    expect(grants.map((c) => c.role)).toEqual(["admin", "child"]);
  });
});

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

  it("SECURITY: a draft key is never a row in the list — only the session it mints is", async () => {
    const { handleSessions, accessManager, makeUser } = freshHarness();
    const user = makeUser("drafter2");
    const store = openSessionStore(
      accessManager.grant(createUserPrincipal(user.userId, "adult", "home"), "session-store"),
    );
    const draftKey = mintDraftKey();
    const { sessionId } = mintOnFirstMessage({ store, mintKey: draftKey, text: "hello" });
    store.close();

    const body = await (await handleSessions(requestAs(user, "/api/v1/sessions"))).json();
    const ids = body.sessions.map((s: { sessionId: string }) => s.sessionId);
    expect(ids).toContain(sessionId);
    expect(ids).not.toContain(draftKey);
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
