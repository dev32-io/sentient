import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { CognitionStatusConnector } from "./cognition-status-connector.ts";

// ---------------------------------------------------------------------------
// Mock SDK Internal
// ---------------------------------------------------------------------------

function createMockInternal(): SentientSDKInternal & {
  messageHandlers: Map<string, (msg: unknown) => void>;
} {
  const messageHandlers = new Map<string, (msg: unknown) => void>();

  return {
    messageHandlers,
    send() {},
    sendBinary() {},
    onMessage(type: string, handler: (msg: unknown) => void) {
      messageHandlers.set(type, handler);
      return () => {
        messageHandlers.delete(type);
      };
    },
    onBinary(_handler: (data: ArrayBuffer) => void) {
      return () => {};
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CognitionStatusConnector", () => {
  it("has capability cognition.status and kind status", () => {
    const connector = new CognitionStatusConnector();
    expect(connector.capability).toBe("cognition.status");
    expect(connector.kind).toBe("status");
  });

  it("starts in idle state", () => {
    const connector = new CognitionStatusConnector();
    expect(connector.state()).toBe("idle");
  });

  it("transitions to thinking on cycle.started", () => {
    const onStateChange = vi.fn();
    const connector = new CognitionStatusConnector({ onStateChange });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("cycle.started")?.({ type: "cycle.started", cycleId: "c1", triggerReason: "test" });

    expect(onStateChange).toHaveBeenCalledWith("thinking");
    expect(connector.state()).toBe("thinking");
  });

  it("transitions to idle on cycle.completed", () => {
    const onStateChange = vi.fn();
    const connector = new CognitionStatusConnector({ onStateChange });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("cycle.started")?.({ type: "cycle.started", cycleId: "c1", triggerReason: "test" });
    internal.messageHandlers.get("cycle.completed")?.({ type: "cycle.completed", cycleId: "c1", effectsInvoked: [] });

    expect(onStateChange).toHaveBeenLastCalledWith("idle");
    expect(connector.state()).toBe("idle");
  });

  it("transitions to idle on cycle.aborted", () => {
    const onStateChange = vi.fn();
    const connector = new CognitionStatusConnector({ onStateChange });
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("cycle.started")?.({ type: "cycle.started", cycleId: "c1", triggerReason: "test" });
    internal.messageHandlers.get("cycle.aborted")?.({ type: "cycle.aborted", cycleId: "c1", reason: "interrupt" });

    expect(onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("does not call onStateChange for duplicate state", () => {
    const onStateChange = vi.fn();
    const connector = new CognitionStatusConnector({ onStateChange });
    const internal = createMockInternal();
    connector.attach(internal);

    // Already idle — cycle.completed should be a no-op.
    internal.messageHandlers.get("cycle.completed")?.({ type: "cycle.completed", cycleId: "c1", effectsInvoked: [] });

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it("resets to idle on detach", () => {
    const connector = new CognitionStatusConnector();
    const internal = createMockInternal();
    connector.attach(internal);

    internal.messageHandlers.get("cycle.started")?.({ type: "cycle.started", cycleId: "c1", triggerReason: "test" });
    expect(connector.state()).toBe("thinking");
    connector.detach();
    expect(connector.state()).toBe("idle");
  });
});
