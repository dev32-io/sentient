import { describe, expect, it } from "vitest";
import { createAmbientEventLog } from "./ambient-event-log.js";
import type { AmbientEvent } from "./ambient-event.js";

function makeEvent(index: number): AmbientEvent {
  return {
    id: `evt-${String(index).padStart(3, "0")}`,
    ts: 1_745_000_000 + index,
    source: "test",
    salienceKey: "sensor.test.event",
    summary: `Event ${index}`,
    raw: { index },
  };
}

describe("createAmbientEventLog", () => {
  it("appends events and returns them in order", () => {
    const log = createAmbientEventLog();
    log.append(makeEvent(1));
    log.append(makeEvent(2));
    log.append(makeEvent(3));

    const recent = log.recent(10);
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.id)).toEqual(["evt-001", "evt-002", "evt-003"]);
  });

  it("caps at capacity, discarding oldest events", () => {
    const CAPACITY = 3;
    const log = createAmbientEventLog(CAPACITY);

    for (let i = 0; i < 5; i++) {
      log.append(makeEvent(i));
    }

    const recent = log.recent(10);
    expect(recent).toHaveLength(CAPACITY);
    expect(recent.map((e) => e.id)).toEqual(["evt-002", "evt-003", "evt-004"]);
  });

  it("recent returns the most recent N events", () => {
    const log = createAmbientEventLog();
    for (let i = 0; i < 10; i++) {
      log.append(makeEvent(i));
    }

    const recent = log.recent(3);
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.id)).toEqual(["evt-007", "evt-008", "evt-009"]);
  });

  it("recent returns empty array for limit <= 0", () => {
    const log = createAmbientEventLog();
    log.append(makeEvent(1));

    expect(log.recent(0)).toEqual([]);
    expect(log.recent(-1)).toEqual([]);
  });

  it("snapshot returns a copy of all events", () => {
    const log = createAmbientEventLog();
    log.append(makeEvent(1));
    log.append(makeEvent(2));

    const snap = log.snapshot();
    expect(snap).toHaveLength(2);

    log.clear();
    expect(log.snapshot()).toHaveLength(0);
    // Snapshot is a copy, not affected by later mutations
    expect(snap).toHaveLength(2);
  });

  it("clear empties the log", () => {
    const log = createAmbientEventLog();
    log.append(makeEvent(1));
    log.append(makeEvent(2));
    log.clear();

    expect(log.recent(10)).toEqual([]);
  });
});
