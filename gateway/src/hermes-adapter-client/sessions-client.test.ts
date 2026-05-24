import { describe, expect, it, vi } from "vitest";
import type { AcpPerProfileConnection } from "./per-profile-connection.ts";
import { listSessionsViaAcp } from "./sessions-client.ts";

// ---------------------------------------------------------------------------
// listSessionsViaAcp — past-sessions list via ACP `session/list`.
// ---------------------------------------------------------------------------

interface FakeListResult {
  sessions: unknown[];
  nextCursor: string | null;
}

const makeConn = (
  result: FakeListResult,
): { conn: AcpPerProfileConnection; calls: Array<{ cwd?: string; cursor?: string }> } => {
  const calls: Array<{ cwd?: string; cursor?: string }> = [];
  const listSessions = vi.fn(async (args: { cwd?: string; cursor?: string }): Promise<FakeListResult> => {
    calls.push(args);
    return result;
  });
  // Only `listSessions` is exercised by listSessionsViaAcp; cast through unknown.
  const conn = { listSessions } as unknown as AcpPerProfileConnection;
  return { conn, calls };
};

describe("listSessionsViaAcp", () => {
  it("calls conn.listSessions and maps rows into SessionRow shape", async () => {
    const updatedAt = "2026-05-07T10:00:00.000Z";
    const expectedMs = Date.parse(updatedAt);
    const { conn, calls } = makeConn({
      sessions: [
        { sessionId: "s-acp-1", cwd: "/home/u", title: "Hello", updatedAt },
        { sessionId: "s-acp-2", cwd: "/home/u", title: null, updatedAt: null },
      ],
      nextCursor: null,
    });

    const out = await listSessionsViaAcp(conn, { cursor: "abc" });

    expect(calls).toEqual([{ cursor: "abc" }]);
    expect(out.nextCursor).toBeNull();
    expect(out.sessions).toHaveLength(2);
    expect(out.sessions[0]).toMatchObject({
      sessionId: "s-acp-1",
      rootId: "s-acp-1",
      title: "Hello",
      startedAt: expectedMs,
      lastActiveAt: expectedMs,
      messageCount: 0,
      isActive: false,
    });
    // Null title falls back to default; null updatedAt → startedAt=0, lastActiveAt=now-ish.
    expect(out.sessions[1]?.title).toBe("New chat");
    expect(out.sessions[1]?.startedAt).toBe(0);
    expect(out.sessions[1]?.lastActiveAt).toBeGreaterThan(0);
  });

  it("drops rows that fail schema validation (e.g. missing sessionId)", async () => {
    const { conn } = makeConn({
      sessions: [
        { sessionId: "ok-1", cwd: "/home/u" },
        { cwd: "/home/u", title: "no id" }, // missing sessionId — should drop
        { sessionId: "ok-2", cwd: "/home/u" },
      ],
      nextCursor: null,
    });

    const out = await listSessionsViaAcp(conn);
    expect(out.sessions.map((s) => s.sessionId)).toEqual(["ok-1", "ok-2"]);
  });

  it("passes nextCursor through (string when present, null when absent)", async () => {
    const fixtureA = makeConn({ sessions: [], nextCursor: "page-2" });
    const a = await listSessionsViaAcp(fixtureA.conn);
    expect(a.nextCursor).toBe("page-2");

    const fixtureB = makeConn({ sessions: [], nextCursor: null });
    const b = await listSessionsViaAcp(fixtureB.conn);
    expect(b.nextCursor).toBeNull();
  });

  it("returns empty list + null cursor when sessions array is empty", async () => {
    const { conn, calls } = makeConn({ sessions: [], nextCursor: null });
    const out = await listSessionsViaAcp(conn);
    expect(out).toEqual({ sessions: [], nextCursor: null });
    // No cursor passed → no cursor key in args.
    expect(calls).toEqual([{}]);
  });
});
