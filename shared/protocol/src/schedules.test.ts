import { describe, expect, it } from "vitest";
import {
  goldenScheduleWireFixtures as fixture,
  scheduleCreateRequestSchema,
  schedulePatchRequestSchema,
  scheduleSchema,
  scheduledSessionCardPageSchema,
} from "./schedules";
import { sessionRowSchema } from "./sessions";

describe("scheduled-message wire boundary", () => {
  it("accepts old session clients plus once-at, once-after, and canonical recurring inputs", () => {
    expect(sessionRowSchema.safeParse(fixture.oldClientSessionRow).success).toBe(true);
    for (const value of [fixture.onceAtCreate, fixture.onceAfterCreate, fixture.weeklyCreate, fixture.monthlyCreate])
      expect(scheduleCreateRequestSchema.safeParse(value).success).toBe(true);
    expect(scheduleSchema.safeParse(fixture.resolvedOnce).success).toBe(true);
  });

  it("rejects mixed timing variants, invalid zones, and non-positive or out-of-bound delays", () => {
    expect(
      scheduleCreateRequestSchema.safeParse({
        ...fixture.onceAtCreate,
        timing: { kind: "once-at", at: fixture.onceAtCreate.timing.at, afterSeconds: 4 },
      }).success,
    ).toBe(false);
    expect(
      scheduleCreateRequestSchema.safeParse({
        ...fixture.onceAfterCreate,
        timing: { kind: "once-after", afterSeconds: 0 },
      }).success,
    ).toBe(false);
    expect(
      scheduleCreateRequestSchema.safeParse({
        ...fixture.onceAfterCreate,
        timing: { kind: "once-after", afterSeconds: 31_536_001 },
      }).success,
    ).toBe(false);
    expect(
      scheduleCreateRequestSchema.safeParse({
        ...fixture.weeklyCreate,
        timing: { ...fixture.weeklyCreate.timing, timeZone: "Mars/Olympus" },
      }).success,
    ).toBe(false);
    expect(
      scheduleCreateRequestSchema.safeParse({
        ...fixture.weeklyCreate,
        timing: { ...fixture.weeklyCreate.timing, weekdays: ["monday", "monday"] },
      }).success,
    ).toBe(false);
    expect(
      scheduleCreateRequestSchema.safeParse({
        ...fixture.monthlyCreate,
        timing: { ...fixture.monthlyCreate.timing, dayOfMonth: undefined },
      }).success,
    ).toBe(false);
  });

  it("requires idempotent creates and optimistic non-empty mutations", () => {
    const { idempotencyKey: _, ...withoutKey } = fixture.onceAfterCreate;
    expect(scheduleCreateRequestSchema.safeParse(withoutKey).success).toBe(false);
    expect(schedulePatchRequestSchema.safeParse({ expectedRevision: 2, changes: { enabled: false } }).success).toBe(
      true,
    );
    expect(schedulePatchRequestSchema.safeParse({ expectedRevision: 0, changes: { enabled: false } }).success).toBe(
      false,
    );
    expect(schedulePatchRequestSchema.safeParse({ expectedRevision: 2, changes: {} }).success).toBe(false);
  });

  it("bounds card pages and keeps failure status separate from content/read state", () => {
    expect(scheduledSessionCardPageSchema.safeParse(fixture.cards).success).toBe(true);
    const completedWithoutPreview = { ...fixture.cards.cards[0], preview: undefined };
    const interruptedWithPreview = { ...fixture.cards.cards[1], preview: "unsafe copied content" };
    expect(scheduledSessionCardPageSchema.safeParse({ cards: [completedWithoutPreview] }).success).toBe(false);
    expect(scheduledSessionCardPageSchema.safeParse({ cards: [interruptedWithPreview] }).success).toBe(false);
    expect(scheduledSessionCardPageSchema.safeParse({ cards: Array(101).fill(fixture.cards.cards[0]) }).success).toBe(
      false,
    );
    expect(scheduledSessionCardPageSchema.safeParse({ cards: [], unreadCount: 1 }).success).toBe(false);
  });
});
