import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorder } from "./VoiceRecorder.tsx";

// The capture adapter owns MediaStream/AudioWorklet plumbing — out of scope
// here (see task-16-fix-brief.md). Stub it so `startRecording()` resolves
// immediately with zero captured frames; the recorder's own FSM (idle →
// recording → review → idle) is what these tests pin.
const { captureStart, captureStop } = vi.hoisted(() => ({
  captureStart: vi.fn(async () => {}),
  captureStop: vi.fn(),
}));

vi.mock("../../adapters/web-audio-capture.ts", () => ({
  createWebAudioCapture: () => ({
    start: captureStart,
    stop: captureStop,
    onAudioData: () => () => {},
    onError: () => () => {},
  }),
}));

const MIN_RECORDING_MS = 6200; // > MIN_RECORDING_SECONDS (6s) so "Use recording" enables

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Drives idle → recording → review via the stubbed capture adapter. */
async function recordToReview(): Promise<void> {
  vi.useFakeTimers();
  fireEvent.click(screen.getByText("Record"));
  // capture.start() resolves on a microtask — flush it under fake timers.
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    vi.advanceTimersByTime(MIN_RECORDING_MS);
  });
  fireEvent.click(screen.getByText("Use recording"));
  vi.useRealTimers();
}

describe("VoiceRecorder", () => {
  it("keeps the blob and name in review when onCreate resolves false", async () => {
    const onCreate = vi.fn().mockResolvedValue(false);
    render(<VoiceRecorder onCreate={onCreate} busy={false} />);

    await recordToReview();
    fireEvent.input(screen.getByPlaceholderText("e.g. Dad"), { target: { value: "Dad" } });
    fireEvent.click(screen.getByText("Save voice"));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const [blobArg, nameArg] = onCreate.mock.calls[0] as [Blob, string];
    expect(blobArg).toBeInstanceOf(Blob);
    expect(nameArg).toBe("Dad");

    // Still in review: name retained, Save button still offered, no reset to idle.
    expect(screen.getByPlaceholderText("e.g. Dad")).toHaveProperty("value", "Dad");
    expect(screen.getByText("Save voice")).toBeTruthy();
    expect(screen.queryByText("Record")).toBeNull();
  });

  it("resets to idle when onCreate resolves true", async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(<VoiceRecorder onCreate={onCreate} busy={false} />);

    await recordToReview();
    fireEvent.input(screen.getByPlaceholderText("e.g. Dad"), { target: { value: "Dad" } });
    fireEvent.click(screen.getByText("Save voice"));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Record")).toBeTruthy());
    expect(screen.queryByPlaceholderText("e.g. Dad")).toBeNull();
  });
});
