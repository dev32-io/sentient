import { describe, expect, it } from "bun:test";
import { createTaskListProjector } from "./task-list.js";

function fixedClock(): { now: () => number; tick: (ms: number) => void } {
  let t = 1_000;
  return {
    now: () => t,
    tick: (ms) => {
      t += ms;
    },
  };
}

describe("TaskListProjector", () => {
  it("adds a foreground row on its running update and stamps the start", () => {
    const clock = fixedClock();
    const p = createTaskListProjector({ now: clock.now });
    p.onTurnStarted("t1");
    expect(
      p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" }),
    ).toBe(true);
    expect(p.items()).toEqual([
      { id: "c1", toolName: "ma_search", kind: "foreground", status: "running", argsPreview: "{}", startedAtMs: 1_000 },
    ]);
    expect(p.turnId()).toBe("t1");
  });

  it("transitions a row in place and stamps the end", () => {
    const clock = fixedClock();
    const p = createTaskListProjector({ now: clock.now });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    clock.tick(250);
    expect(p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" })).toBe(
      true,
    );
    expect(p.items()).toHaveLength(1);
    expect(p.items()[0]?.status).toBe("done");
    expect(p.items()[0]?.startedAtMs).toBe(1_000);
    expect(p.items()[0]?.endedAtMs).toBe(1_250);
  });

  it("keys a background dispatch on its taskId, not its toolCallId", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", {
      toolCallId: "c9",
      toolName: "delegateTask",
      status: "running",
      argsPreview: "{}",
      taskId: "task-7",
    });
    expect(p.items()[0]?.id).toBe("task-7");
    expect(p.items()[0]?.kind).toBe("background");
  });

  it("drops foreground rows at the turn boundary and keeps background ones", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" });
    p.onToolUpdate("t1", {
      toolCallId: "c2",
      toolName: "delegateTask",
      status: "running",
      argsPreview: "{}",
      taskId: "task-7",
    });
    expect(p.onTurnEnded("t1")).toBe(true);
    expect(p.items().map((i) => i.id)).toEqual(["task-7"]);
    // No turn owns the list any more — only a background row survives it.
    expect(p.turnId()).toBeNull();
  });

  it("removes a background row when its delegation reports terminal", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", {
      toolCallId: "c2",
      toolName: "delegateTask",
      status: "running",
      argsPreview: "{}",
      taskId: "task-7",
    });
    p.onTurnEnded("t1");
    expect(p.onDelegationProgress({ taskId: "task-7", turnId: "t1", agent: "hermes", status: "done" })).toBe(true);
    expect(p.items()).toEqual([]);
  });

  it("ignores a turn boundary for a turn it does not own", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    expect(p.onTurnEnded("t-other")).toBe(false);
    expect(p.items()).toHaveLength(1);
  });

  it("clears the previous turn's rows when a new turn starts", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" });
    expect(p.onTurnStarted("t2")).toBe(true);
    expect(p.items()).toEqual([]);
    expect(p.turnId()).toBe("t2");
  });

  it("reports no change when an identical update repeats", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    expect(
      p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" }),
    ).toBe(false);
  });
});
