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

  // react-loop.ts actually reports a background dispatch TWICE for the same
  // call: a toolCallId-keyed "running" update fired before broker.dispatch()
  // resolves (react-loop.ts:269, no taskId yet), then a taskId-keyed
  // "running" update once appendBackgroundReceipt sees the resolved taskId
  // (react-loop.ts:218) — despite the wire schema's comment claiming a
  // single update. Without promotion this produces two rows, one of them a
  // phantom foreground tile stuck at "running" forever.
  it("promotes the pre-resolution placeholder into its background row on the taskId update", () => {
    const clock = fixedClock();
    const p = createTaskListProjector({ now: clock.now });
    p.onTurnStarted("t1");
    // First: the loop reports "this call started" before it knows the call
    // is background.
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "delegateTask", status: "running", argsPreview: "{}" });
    clock.tick(30);
    // Second: the same call's post-resolution receipt, now carrying taskId.
    expect(
      p.onToolUpdate("t1", {
        toolCallId: "c1",
        toolName: "delegateTask",
        status: "running",
        argsPreview: "{}",
        taskId: "task-7",
      }),
    ).toBe(true);
    expect(p.items()).toHaveLength(1);
    expect(p.items()).toEqual([
      {
        id: "task-7",
        toolName: "delegateTask",
        kind: "background",
        status: "running",
        argsPreview: "{}",
        startedAtMs: 1_000,
      },
    ]);
  });

  it("keeps a finished foreground row AND a background row past the turn boundary", () => {
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
    // The strip is a look-back record now, not a live-only view: nothing
    // clears a foreground row until the NEXT turn starts (onTurnStarted).
    expect(p.items().map((i) => i.id)).toEqual(["c1", "task-7"]);
    // No turn owns the list any more, even though its rows are still here.
    expect(p.turnId()).toBeNull();
  });

  it("clears a finished foreground row only when the NEXT turn starts, not at its own turn's end", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" });
    p.onTurnEnded("t1");
    // Still here right after the turn ends — this is the mutation-check case:
    // deleting the row inside onTurnEnded (the old rule) makes this line fail.
    expect(p.items().map((i) => i.id)).toEqual(["c1"]);
    expect(p.onTurnStarted("t2")).toBe(true);
    expect(p.items()).toEqual([]);
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

  it("ignores a foreground update for a turn it does not own", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    expect(
      p.onToolUpdate("t-other", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" }),
    ).toBe(false);
    expect(p.items()).toHaveLength(0);
    expect(p.turnId()).toBe("t1");
  });

  it("still records a background update after its own turn has ended, without resurrecting turnId", () => {
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
    expect(p.turnId()).toBeNull();
    // A background row legitimately outlives its turn, so a late update for
    // it must not be swallowed by the ownership guard...
    expect(
      p.onToolUpdate("t1", {
        toolCallId: "c2",
        toolName: "delegateTask",
        status: "done",
        argsPreview: "{}",
        taskId: "task-7",
      }),
    ).toBe(true);
    expect(p.items()[0]?.status).toBe("done");
    // ...but it must not resurrect currentTurnId either — no turn owns the
    // list, background-only or not.
    expect(p.turnId()).toBeNull();
  });

  // Change 2's pin: cancellation.ts drives this once it has closed a turn's
  // unreplied tool calls in the store, so a call cut off mid-flight reaches a
  // terminal status instead of sitting at "running" forever now that
  // onTurnEnded no longer deletes the row itself.
  it("terminalizes a running row to error when its tool call is closed", () => {
    const clock = fixedClock();
    const p = createTaskListProjector({ now: clock.now });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    clock.tick(50);
    expect(p.onToolCallsClosed(["c1"])).toBe(true);
    expect(p.items()).toEqual([
      {
        id: "c1",
        toolName: "ma_search",
        kind: "foreground",
        status: "error",
        argsPreview: "{}",
        startedAtMs: 1_000,
        endedAtMs: 1_050,
      },
    ]);
  });

  it("leaves an already-terminal or nonexistent row untouched when closed", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" });
    // "c1" already settled on its own; "c9" never existed. Neither is this
    // module's job to invent — closing is a no-op for both.
    expect(p.onToolCallsClosed(["c1", "c9"])).toBe(false);
    expect(p.items()[0]?.status).toBe("done");
  });

  // The general backstop (code review follow-up to Change 2): a turn can also
  // end by provider failure, timeout, or an unexpected throw out of the
  // ReAct loop — none of which route through cancellation.ts's
  // `onToolCallsClosed`. `terminalizeOrphanedForeground` is what
  // SessionRuntime's settle continuation drives for EVERY turn end, so this
  // gap closes structurally rather than by enumerating failure paths.
  it("terminalizes a still-running foreground row when the turn settles for any other reason", () => {
    const clock = fixedClock();
    const p = createTaskListProjector({ now: clock.now });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    clock.tick(75);
    expect(p.terminalizeOrphanedForeground("t1")).toBe(true);
    expect(p.items()).toEqual([
      {
        id: "c1",
        toolName: "ma_search",
        kind: "foreground",
        status: "error",
        argsPreview: "{}",
        startedAtMs: 1_000,
        endedAtMs: 1_075,
      },
    ]);
  });

  it("leaves a running BACKGROUND row alone — a delegateTask outliving its turn is the point", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", {
      toolCallId: "c2",
      toolName: "delegateTask",
      status: "running",
      argsPreview: "{}",
      taskId: "task-7",
    });
    expect(p.terminalizeOrphanedForeground("t1")).toBe(false);
    expect(p.items()[0]?.status).toBe("running");
    expect(p.items()[0]?.kind).toBe("background");
  });

  it("reports no change when nothing is running", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "done", argsPreview: "{}" });
    expect(p.terminalizeOrphanedForeground("t1")).toBe(false);
    expect(p.items()[0]?.status).toBe("done");
  });

  // The interaction this module's header now documents: on barge-in/interrupt
  // cancellation.ts's `onToolCallsClosed` already terminalizes every
  // still-running row BEFORE `controller.abort()`, so the sweep that runs
  // later in the settle continuation must find nothing left to do.
  it("is a clean no-op once onToolCallsClosed already terminalized the row (the interrupt/barge-in path)", () => {
    const p = createTaskListProjector({ now: () => 5 });
    p.onTurnStarted("t1");
    p.onToolUpdate("t1", { toolCallId: "c1", toolName: "ma_search", status: "running", argsPreview: "{}" });
    expect(p.onToolCallsClosed(["c1"])).toBe(true);
    expect(p.terminalizeOrphanedForeground("t1")).toBe(false);
    expect(p.items()[0]?.status).toBe("error");
  });
});
