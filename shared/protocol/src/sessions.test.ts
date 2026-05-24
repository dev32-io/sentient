import { describe, expect, it } from "vitest";
import {
  sessionCreatedEventSchema,
  sessionNewSchema,
  sessionRowSchema,
  sessionSwitchSchema,
  sessionSwitchedEventSchema,
  sessionsDeleteResultSchema,
  sessionsDeleteSchema,
  sessionsErrorSchema,
  sessionsListResultSchema,
  sessionsListSchema,
  sessionsRenameResultSchema,
  sessionsRenameSchema,
  sessionsSearchSchema,
} from "./sessions.ts";

describe("SessionRow", () => {
  it("parses a valid row with all fields", () => {
    const row = {
      sessionId: "abc",
      rootId: "root-abc",
      title: "Hello",
      startedAt: 1_700_000_000_000,
      lastActiveAt: 1_700_000_500_000,
      messageCount: 12,
      isActive: false,
    };
    expect(sessionRowSchema.parse(row)).toEqual(row);
  });

  it("rejects negative messageCount", () => {
    const bad = {
      sessionId: "abc",
      rootId: "root-abc",
      title: "x",
      startedAt: 0,
      lastActiveAt: 0,
      messageCount: -1,
      isActive: false,
    };
    expect(sessionRowSchema.safeParse(bad).success).toBe(false);
  });
});

describe("sessions WS frames", () => {
  it("accepts sessions.list with positive bounds", () => {
    expect(
      sessionsListSchema.safeParse({
        type: "sessions.list",
        requestId: "r1",
        limit: 20,
        offset: 0,
      }).success,
    ).toBe(true);
  });

  it("rejects sessions.list with limit > 100", () => {
    expect(
      sessionsListSchema.safeParse({
        type: "sessions.list",
        requestId: "r1",
        limit: 999,
        offset: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts sessions.search with non-empty query", () => {
    expect(
      sessionsSearchSchema.safeParse({
        type: "sessions.search",
        requestId: "r1",
        q: "weather",
        limit: 10,
      }).success,
    ).toBe(true);
  });

  it("accepts session.switch with sessionId", () => {
    expect(
      sessionSwitchSchema.safeParse({
        type: "session.switch",
        requestId: "r1",
        sessionId: "abc",
      }).success,
    ).toBe(true);
  });

  it("rejects sessions.rename with title > 200 chars", () => {
    expect(
      sessionsRenameSchema.safeParse({
        type: "sessions.rename",
        requestId: "r1",
        sessionId: "abc",
        title: "x".repeat(201),
      }).success,
    ).toBe(false);
  });

  it("rejects sessions.rename with control chars", () => {
    expect(
      sessionsRenameSchema.safeParse({
        type: "sessions.rename",
        requestId: "r1",
        sessionId: "abc",
        title: "hello\x07world",
      }).success,
    ).toBe(false);
  });

  it("accepts session.created event", () => {
    expect(
      sessionCreatedEventSchema.safeParse({
        type: "session.created",
        sessionId: "abc",
        title: "New chat",
        ts: 1_700_000_000_000,
      }).success,
    ).toBe(true);
  });

  it("accepts session.switched event", () => {
    expect(
      sessionSwitchedEventSchema.safeParse({
        type: "session.switched",
        sessionId: "abc",
        title: "Hello",
        ts: 1_700_000_000_000,
      }).success,
    ).toBe(true);
  });

  it("accepts sessions.error", () => {
    expect(
      sessionsErrorSchema.safeParse({
        type: "sessions.error",
        requestId: "r1",
        code: "forbidden",
        message: "not your session",
      }).success,
    ).toBe(true);
  });

  it("accepts sessions.list.result with empty items", () => {
    expect(
      sessionsListResultSchema.safeParse({
        type: "sessions.list.result",
        requestId: "r1",
        items: [],
        total: 0,
        hasMore: false,
      }).success,
    ).toBe(true);
  });

  it("accepts sessions.delete.result with requestId + sessionId", () => {
    expect(
      sessionsDeleteResultSchema.safeParse({
        type: "sessions.delete.result",
        requestId: "r1",
        sessionId: "abc",
      }).success,
    ).toBe(true);
  });

  it("rejects sessions.delete.result missing requestId", () => {
    expect(
      sessionsDeleteResultSchema.safeParse({
        type: "sessions.delete.result",
        sessionId: "abc",
      }).success,
    ).toBe(false);
  });

  it("accepts sessions.rename.result with title", () => {
    expect(
      sessionsRenameResultSchema.safeParse({
        type: "sessions.rename.result",
        requestId: "r1",
        sessionId: "abc",
        title: "Renamed",
      }).success,
    ).toBe(true);
  });
});

describe("sessions module exports", () => {
  it("exports sessionsDeleteSchema and sessionNewSchema for envelope wiring", () => {
    expect(
      sessionsDeleteSchema.safeParse({
        type: "sessions.delete",
        requestId: "r1",
        sessionId: "abc",
      }).success,
    ).toBe(true);
    expect(
      sessionNewSchema.safeParse({
        type: "session.new",
        requestId: "r1",
      }).success,
    ).toBe(true);
  });
});
