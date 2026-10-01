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

import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { type UserRole, sessionHistoryFieldsSchema } from "@sentient/protocol";
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
  deleted: string[];
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
  const deleted: string[] = [];
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
    onSessionDeleted: (_principal, sessionId) => deleted.push(sessionId),
  };
  return {
    handleSessions: createSessionsHandler(deps),
    accessManager,
    grants,
    deleted,
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
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      const first = seedSession(accessManager, user, "first");
      clock.mockReturnValue(2000);
      const second = seedSession(accessManager, user, "second");
      const body = await (await handleSessions(requestAs(user, "/api/v1/sessions"))).json();
      expect(body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([second, first]);
    } finally {
      clock.mockRestore();
    }
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

describe("GET /api/v1/sessions/search", () => {
  it("routes search before session IDs, filters owned titles, and preserves Cube pin after deletion", async () => {
    const h = freshHarness();
    const owner = h.makeUser("search-owner");
    const other = h.makeUser("search-other");
    const store = openSessionStore(
      h.accessManager.grant(createUserPrincipal(owner.userId, "adult", "home"), "session-store"),
    );
    const first = store.admitCubeInput({
      inputId: "synthetic-search-first",
      expectedFence: store.getCubeAdmissionFence(),
      dreamerHour: 3,
      now: Date.now(),
      entry: {
        kind: "user",
        turnId: "synthetic-turn",
        replyId: null,
        createdAt: Date.now(),
        text: "synthetic",
        toolCallId: null,
        toolName: null,
        toolArgs: null,
        cutoff: null,
        compactedThroughSeq: null,
      },
    });
    if (first.status !== "accepted") throw new Error(first.status);
    const version = store.getSession(first.sessionId)?.version;
    if (version === undefined) throw new Error("missing session");
    store.setTitle(first.sessionId, "Synthetic Cube day 1", "user", version);
    const latest = store.admitCubeInput({
      inputId: "synthetic-search-latest",
      expectedFence: store.getCubeAdmissionFence(),
      dreamerHour: 3,
      now: Date.now() + 2 * 86_400_000,
      entry: {
        kind: "user",
        turnId: "synthetic-latest-turn",
        replyId: null,
        createdAt: Date.now(),
        text: "synthetic",
        toolCallId: null,
        toolName: null,
        toolArgs: null,
        cutoff: null,
        compactedThroughSeq: null,
      },
    });
    if (latest.status !== "accepted") throw new Error(latest.status);
    store.close();
    seedSession(h.accessManager, owner, "ordinary");
    const foreignId = seedSession(h.accessManager, other, "private");
    const foreignStore = openSessionStore(
      h.accessManager.grant(createUserPrincipal(other.userId, "adult", "home"), "session-store"),
    );
    expect(foreignStore.setTitle(foreignId, "Synthetic Cube private", "user", 1)).toBe(true);
    foreignStore.close();
    expect(
      (
        await h.handleSessions(
          new Request(`https://x/api/v1/sessions/${latest.sessionId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${owner.token}` },
          }),
        )
      ).status,
    ).toBe(204);

    const path = `/api/v1/sessions/search?q=synthetic%20cube&limit=20&userId=${other.userId}`;
    expect((await h.handleSessions(new Request(`https://x${path}`))).status).toBe(401);
    const response = await h.handleSessions(requestAs(owner, path));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual([
      expect.objectContaining({
        sessionId: first.sessionId,
        title: "Synthetic Cube day 1",
        provenance: "cube",
        readOnly: true,
        currentPin: true,
      }),
    ]);
    expect((await (await h.handleSessions(requestAs(other, path))).json()).items).toEqual([
      expect.objectContaining({ sessionId: foreignId, title: "Synthetic Cube private" }),
    ]);
    expect(
      (await (await h.handleSessions(requestAs(owner, "/api/v1/sessions/search?q=synthetic&limit=0"))).json()).items,
    ).toHaveLength(1);
    expect(
      (
        await h.handleSessions(
          new Request("https://x/api/v1/sessions/search", {
            method: "DELETE",
            headers: { authorization: `Bearer ${owner.token}` },
          }),
        )
      ).status,
    ).toBe(405);
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
    expect(body.items[0]).toMatchObject({ kind: "user", content: "hello from the seed", sessionId });
  });
});

describe("DELETE session", () => {
  it("rejects malformed ids before opening the session store", async () => {
    const h = freshHarness();
    const user = h.makeUser("malformed-delete");
    const response = await h.handleSessions(
      new Request("https://x/api/v1/sessions/arbitrary-user-text", {
        method: "DELETE",
        headers: { authorization: `Bearer ${user.token}` },
      }),
    );

    expect(response.status).toBe(404);
    expect(h.grants).toHaveLength(0);
    expect(h.deleted).toEqual([]);
  });

  it("returns 404 for an unknown well-formed id without fencing future creation", async () => {
    const h = freshHarness();
    const user = h.makeUser("unknown-delete");
    const id = mintSessionId();
    const response = await h.handleSessions(
      new Request(`https://x/api/v1/sessions/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${user.token}` },
      }),
    );

    expect(response.status).toBe(404);
    expect(h.deleted).toEqual([]);
    const store = openSessionStore(
      h.accessManager.grant(createUserPrincipal(user.userId, "adult", "home"), "session-store"),
    );
    expect(store.listFileCleanupIntents(10)).toEqual([]);
    expect(() => store.createSession(id, `mint-${id}`)).not.toThrow();
    store.close();
  });

  it("deletes owned history idempotently and invokes runtime teardown on retry", async () => {
    const h = freshHarness();
    const user = h.makeUser("delete");
    const id = seedSession(h.accessManager, user, "synthetic delete fixture");
    const remove = () =>
      h.handleSessions(
        new Request(`https://x/api/v1/sessions/${id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${user.token}` },
        }),
      );
    expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(204);
    expect(h.deleted).toEqual([id, id]);
    expect((await h.handleSessions(requestAs(user, `/api/v1/sessions/${id}/messages`))).status).toBe(404);
    const list = await h.handleSessions(requestAs(user, "/api/v1/sessions"));
    expect(await list.json()).toEqual({ sessions: [] });
  });

  it("does not expose or delete another user's session", async () => {
    const h = freshHarness();
    const owner = h.makeUser("owner");
    const stranger = h.makeUser("stranger");
    const id = seedSession(h.accessManager, owner, "synthetic private fixture");
    const response = await h.handleSessions(
      new Request(`https://x/api/v1/sessions/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${stranger.token}` },
      }),
    );
    expect(response.status).toBe(404);
    expect(h.deleted).toEqual([]);
    expect((await h.handleSessions(requestAs(owner, `/api/v1/sessions/${id}/messages`))).status).toBe(200);
  });
});

it("projects durable Cube history flags without runtime admission and keeps owner deletion", async () => {
  const h = freshHarness();
  const user = h.makeUser("cube-history");
  const foreign = h.makeUser("foreign");
  const store = openSessionStore(
    h.accessManager.grant(createUserPrincipal(user.userId, "adult", "home"), "session-store"),
  );
  const human = mintSessionId();
  store.createSession(human, "human-draft");
  const admitted = store.admitCubeInput({
    inputId: "synthetic-input",
    expectedFence: store.getCubeAdmissionFence(),
    dreamerHour: 3,
    now: Date.now(),
    entry: {
      kind: "user",
      turnId: "synthetic-turn",
      replyId: null,
      createdAt: Date.now(),
      text: "synthetic",
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      cutoff: null,
      compactedThroughSeq: null,
    },
  });
  if (admitted.status !== "accepted") throw new Error(admitted.status);
  store.closeCubeSessionExecution(admitted.sessionId, "revoked");
  store.close();
  const list = await (await h.handleSessions(requestAs(user, "/api/v1/sessions"))).json();
  expect(list.sessions.find((s: { sessionId: string }) => s.sessionId === human)).toMatchObject({
    provenance: "human",
    readOnly: false,
    currentPin: false,
    executionClosed: false,
  });
  expect(list.sessions.find((s: { sessionId: string }) => s.sessionId === admitted.sessionId)).toMatchObject({
    provenance: "cube",
    readOnly: true,
    currentPin: true,
    executionClosed: true,
  });
  const messages = await (
    await h.handleSessions(requestAs(user, `/api/v1/sessions/${admitted.sessionId}/messages`))
  ).json();
  expect(sessionHistoryFieldsSchema.parse(messages)).toEqual({
    provenance: "cube",
    readOnly: true,
    currentPin: true,
    executionClosed: true,
  });
  expect(messages.items).toHaveLength(1);
  expect((await h.handleSessions(requestAs(foreign, `/api/v1/sessions/${admitted.sessionId}/messages`))).status).toBe(
    404,
  );
  const deleted = await h.handleSessions(
    new Request(`https://x/api/v1/sessions/${admitted.sessionId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${user.token}` },
    }),
  );
  expect(deleted.status).toBe(204);
  const remaining = await (await h.handleSessions(requestAs(user, "/api/v1/sessions"))).json();
  expect(remaining.sessions).toHaveLength(1);
  expect(remaining.sessions[0].currentPin).toBe(false);
});
