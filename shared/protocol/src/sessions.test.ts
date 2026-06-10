import { describe, expect, it } from "vitest";
import {
  conversationActivateSchema,
  sessionCreatedEventSchema,
  sessionNewSchema,
  sessionRowSchema,
  sessionSwitchedEventSchema,
  sessionsDeletedEventSchema,
  sessionsErrorSchema,
  sessionsRenamedEventSchema,
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

describe("sessions lifecycle frames", () => {
  it("accepts session.new with requestId", () => {
    expect(
      sessionNewSchema.safeParse({
        type: "session.new",
        requestId: "r1",
      }).success,
    ).toBe(true);
  });

  it("accepts conversation.activate without requestId", () => {
    expect(
      conversationActivateSchema.safeParse({
        type: "conversation.activate",
        sessionId: "abc",
      }).success,
    ).toBe(true);
  });

  it("rejects conversation.activate missing sessionId", () => {
    expect(
      conversationActivateSchema.safeParse({
        type: "conversation.activate",
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

  it("accepts sessions.deleted broadcast", () => {
    expect(
      sessionsDeletedEventSchema.safeParse({
        type: "sessions.deleted",
        sessionId: "abc",
      }).success,
    ).toBe(true);
  });

  it("accepts sessions.renamed broadcast", () => {
    expect(
      sessionsRenamedEventSchema.safeParse({
        type: "sessions.renamed",
        sessionId: "abc",
        title: "Renamed",
      }).success,
    ).toBe(true);
  });

  it("accepts sessions.error with requestId", () => {
    expect(
      sessionsErrorSchema.safeParse({
        type: "sessions.error",
        requestId: "r1",
        code: "forbidden",
        message: "not your session",
      }).success,
    ).toBe(true);
  });

  it("accepts sessions.error without requestId (conversation.activate failure)", () => {
    expect(
      sessionsErrorSchema.safeParse({
        type: "sessions.error",
        code: "forbidden",
        message: "not your session",
      }).success,
    ).toBe(true);
  });
});
