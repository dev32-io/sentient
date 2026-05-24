import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwaitingTracker } from "./awaiting-tracker.ts";

describe("createAwaitingTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts disarmed", () => {
    const t = createAwaitingTracker({ onChange: vi.fn() });
    expect(t.isAwaiting()).toBe(false);
  });

  it("arm() flips isAwaiting=true and fires onChange", () => {
    const onChange = vi.fn();
    const t = createAwaitingTracker({ onChange });
    t.arm();
    expect(t.isAwaiting()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("double arm() is a no-op", () => {
    const onChange = vi.fn();
    const t = createAwaitingTracker({ onChange });
    t.arm();
    t.arm();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("onAudioStart disarms", () => {
    const onChange = vi.fn();
    const t = createAwaitingTracker({ onChange });
    t.arm();
    onChange.mockClear();
    t.onAudioStart();
    expect(t.isAwaiting()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("onPlaybackEnded disarms", () => {
    const t = createAwaitingTracker({ onChange: vi.fn() });
    t.arm();
    t.onPlaybackEnded();
    expect(t.isAwaiting()).toBe(false);
  });

  it("onCognitionIdle with audio playing does not start grace timer", () => {
    const t = createAwaitingTracker({ onChange: vi.fn(), graceMs: 500 });
    t.arm();
    t.onCognitionIdle(true); // audio already playing — audio path owns visibility
    vi.advanceTimersByTime(1000);
    expect(t.isAwaiting()).toBe(true); // still awaiting; audio path will disarm
  });

  it("onCognitionIdle without audio starts grace timer; expires and disarms", () => {
    const onChange = vi.fn();
    const t = createAwaitingTracker({ onChange, graceMs: 500 });
    t.arm();
    onChange.mockClear();
    t.onCognitionIdle(false);
    expect(t.isAwaiting()).toBe(true); // still awaiting until timer fires
    vi.advanceTimersByTime(501);
    expect(t.isAwaiting()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("onCognitionActive cancels a pending grace timer", () => {
    const t = createAwaitingTracker({ onChange: vi.fn(), graceMs: 500 });
    t.arm();
    t.onCognitionIdle(false);
    t.onCognitionActive();
    vi.advanceTimersByTime(1000);
    expect(t.isAwaiting()).toBe(true);
  });

  it("onAudioStart cancels a pending grace timer", () => {
    const t = createAwaitingTracker({ onChange: vi.fn(), graceMs: 500 });
    t.arm();
    t.onCognitionIdle(false);
    t.onAudioStart();
    vi.advanceTimersByTime(1000);
    expect(t.isAwaiting()).toBe(false);
  });

  it("arm() while grace timer is pending cancels the timer and stays armed", () => {
    const t = createAwaitingTracker({ onChange: vi.fn(), graceMs: 500 });
    t.arm();
    t.onCognitionIdle(false);
    t.arm(); // rearm (new sendText while still in grace)
    vi.advanceTimersByTime(1000);
    expect(t.isAwaiting()).toBe(true);
  });

  it("dispose cancels pending timers", () => {
    const onChange = vi.fn();
    const t = createAwaitingTracker({ onChange, graceMs: 500 });
    t.arm();
    t.onCognitionIdle(false);
    t.dispose();
    vi.advanceTimersByTime(1000);
    // dispose cancels timer but does NOT disarm — state is unchanged, no extra onChange.
    expect(onChange).toHaveBeenCalledTimes(1); // only the arm
  });
});
