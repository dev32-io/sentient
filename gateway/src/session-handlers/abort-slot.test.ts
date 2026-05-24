import { describe, expect, it, vi } from "vitest";
import { createAbortSlot } from "./abort-slot.js";

describe("AbortSlot", () => {
  it("returns null currentId when empty", () => {
    const slot = createAbortSlot("test");
    expect(slot.currentId()).toBeNull();
  });

  it("returns registered id from currentId", () => {
    const slot = createAbortSlot("test");
    slot.register("cycle-1", new AbortController());
    expect(slot.currentId()).toBe("cycle-1");
  });

  it("clears id on complete when id matches", () => {
    const slot = createAbortSlot("test");
    slot.register("cycle-1", new AbortController());
    slot.complete("cycle-1");
    expect(slot.currentId()).toBeNull();
  });

  it("ignores complete when id does not match current", () => {
    const slot = createAbortSlot("test");
    slot.register("cycle-1", new AbortController());
    slot.complete("cycle-2");
    expect(slot.currentId()).toBe("cycle-1");
  });

  it("cancelCurrent aborts controller and returns id", () => {
    const slot = createAbortSlot("test");
    const ctrl = new AbortController();
    slot.register("cycle-1", ctrl);
    const id = slot.cancelCurrent("reason-x");
    expect(id).toBe("cycle-1");
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("cancelCurrent returns null when empty", () => {
    const slot = createAbortSlot("test");
    expect(slot.cancelCurrent("r")).toBeNull();
  });

  it("onComplete fires with id when complete is called", () => {
    const slot = createAbortSlot("test");
    const listener = vi.fn();
    slot.onComplete(listener);
    slot.register("cycle-1", new AbortController());
    slot.complete("cycle-1");
    expect(listener).toHaveBeenCalledWith("cycle-1");
  });

  it("onComplete does not fire on cancelCurrent", () => {
    const slot = createAbortSlot("test");
    const listener = vi.fn();
    slot.onComplete(listener);
    slot.register("cycle-1", new AbortController());
    slot.cancelCurrent("r");
    expect(listener).not.toHaveBeenCalled();
  });

  it("onComplete unsubscribe stops future notifications", () => {
    const slot = createAbortSlot("test");
    const listener = vi.fn();
    const unsub = slot.onComplete(listener);
    unsub();
    slot.register("cycle-1", new AbortController());
    slot.complete("cycle-1");
    expect(listener).not.toHaveBeenCalled();
  });

  it("register overwrites previous slot", () => {
    const slot = createAbortSlot("test");
    const first = new AbortController();
    slot.register("cycle-1", first);
    slot.register("cycle-2", new AbortController());
    expect(slot.currentId()).toBe("cycle-2");
    // first controller left intact — caller's responsibility to clean up
    expect(first.signal.aborted).toBe(false);
  });
});
