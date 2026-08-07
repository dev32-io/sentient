import { beforeEach, describe, expect, it } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { CognitionStatusConnector } from "./cognition-status-connector.ts";

function createMockSDK(): { sdk: SentientSDKInternal; emit: (type: string, msg: unknown) => void } {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  return {
    sdk: {
      send: () => {},
      sendBinary: () => {},
      onMessage: (type, handler) => {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
        return () => {};
      },
      onBinary: () => () => {},
    },
    emit: (type, msg) => {
      for (const h of handlers.get(type) ?? []) h(msg);
    },
  };
}

describe("CognitionStatusConnector", () => {
  let connector: CognitionStatusConnector;
  let mock: ReturnType<typeof createMockSDK>;

  beforeEach(() => {
    connector = new CognitionStatusConnector();
    mock = createMockSDK();
    connector.attach(mock.sdk);
  });

  it("goes thinking on turn.started", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    expect(connector.state()).toBe("thinking");
  });

  it("stays thinking while a second turn is still open after the first completes", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.started", { turnId: "t-2", trigger: "background-completion" });
    mock.emit("turn.completed", { turnId: "t-1" });
    expect(connector.state()).toBe("thinking");
  });

  it("returns to idle only once every turn has settled", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("turn.started", { turnId: "t-2", trigger: "background-completion" });
    mock.emit("turn.completed", { turnId: "t-1" });
    mock.emit("turn.aborted", { turnId: "t-2", cutoff: "interrupt" });
    expect(connector.state()).toBe("idle");
  });

  it("reports acting while a FOREGROUND row is running and thinking again once it settles", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("tasklist.state", {
      turnId: "t-1",
      items: [
        {
          id: "c-1",
          toolName: "home_assistant.get_state",
          kind: "foreground",
          status: "running",
          argsPreview: "entity=light.kitchen",
          startedAtMs: 1000,
        },
      ],
    });
    expect(connector.state()).toBe("acting");

    // Full state, last-one-wins: the settled row replaces the running one.
    mock.emit("tasklist.state", {
      turnId: "t-1",
      items: [
        {
          id: "c-1",
          toolName: "home_assistant.get_state",
          kind: "foreground",
          status: "done",
          argsPreview: "entity=light.kitchen",
          startedAtMs: 1000,
          endedAtMs: 1200,
        },
      ],
    });
    expect(connector.state()).toBe("thinking");
  });

  it("does not report acting for a BACKGROUND row alone — the loop is not waiting on it", () => {
    // `delegateTask` is fire-and-steer: it outlives the turn that dispatched it,
    // so counting it would pin cognition at acting for as long as the task runs.
    // Its surface is DelegationProgressConnector, not this one.
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("tasklist.state", {
      turnId: "t-1",
      items: [
        {
          id: "task-1",
          toolName: "delegateTask",
          kind: "background",
          status: "running",
          argsPreview: "agent=hermes",
          startedAtMs: 1000,
        },
      ],
    });
    expect(connector.state()).toBe("thinking");
  });

  it("goes idle when the turn ends even though a background row survives on the strip", () => {
    mock.emit("turn.started", { turnId: "t-1", trigger: "user" });
    mock.emit("tasklist.state", {
      turnId: "t-1",
      items: [
        { id: "c-1", toolName: "search", kind: "foreground", status: "running", argsPreview: "", startedAtMs: 1000 },
        {
          id: "task-1",
          toolName: "delegateTask",
          kind: "background",
          status: "running",
          argsPreview: "",
          startedAtMs: 1000,
        },
      ],
    });
    expect(connector.state()).toBe("acting");

    // Foreground rows die with their turn at the source (runtime/task-list.ts);
    // the background one rides on with a null turnId.
    mock.emit("tasklist.state", {
      turnId: null,
      items: [
        {
          id: "task-1",
          toolName: "delegateTask",
          kind: "background",
          status: "running",
          argsPreview: "",
          startedAtMs: 1000,
        },
      ],
    });
    mock.emit("turn.completed", { turnId: "t-1" });
    expect(connector.state()).toBe("idle");
  });

  it("ignores a tasklist.state that arrives with no turn in flight", () => {
    mock.emit("tasklist.state", {
      turnId: null,
      items: [
        { id: "c-1", toolName: "search", kind: "foreground", status: "running", argsPreview: "", startedAtMs: 1000 },
      ],
    });
    expect(connector.state()).toBe("idle");
  });
});
