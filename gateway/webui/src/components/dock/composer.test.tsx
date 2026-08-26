import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type CaptureIntent, type ChatComposerProps } from "./index.ts";
import { DOCK_STYLES } from "./dock-styles.tsx";
import { VOICE_CAPTURE_STATES, isVoiceCaptureLive, mapVoiceCapturePresentation } from "./voice-capture-state.ts";

function composerProps(overrides: Partial<ChatComposerProps> = {}): ChatComposerProps {
  return {
    cycleStatus: "idle",
    connectionReady: true,
    captureActive: false,
    ttsEnabled: true,
    suggestions: [],
    tasks: [],
    value: "",
    onValueChange: vi.fn(),
    onTextSubmit: vi.fn(),
    onCaptureIntent: vi.fn(async () => undefined),
    onTtsToggle: vi.fn(),
    onInterrupt: vi.fn(),
    onSuggestionClick: vi.fn(),
    ...overrides,
  };
}

function ControlledComposer({ props }: { props: ChatComposerProps }): JSX.Element {
  const [value, setValue] = useState(props.value);
  return (
    <ChatComposer
      {...props}
      value={value}
      onValueChange={(next) => {
        props.onValueChange(next);
        setValue(next);
      }}
    />
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("ChatComposer semantic boundary", () => {
  it("reports draft changes and submits trimmed text while preserving Shift+Enter", () => {
    const props = composerProps();
    render(<ControlledComposer props={props} />);
    const editor = screen.getByRole("textbox", { name: "Message Sentient" });

    fireEvent.input(editor, { target: { value: "  hello  " } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(props.onTextSubmit).not.toHaveBeenCalled();
    fireEvent.input(editor, { target: { value: "  hello\nthere  " } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(props.onTextSubmit).toHaveBeenCalledWith("hello\nthere");
    expect(props.onValueChange).toHaveBeenLastCalledWith("");
    expect(document.activeElement).toBe(editor);
    expect(props.onCaptureIntent).not.toHaveBeenCalled();
  });

  it("keeps the draft usable across reconnect and capture permission failure", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    const props = composerProps({
      onCaptureIntent: vi.fn(async (intent: CaptureIntent) => {
        if (intent.type === "start") throw denied;
      }),
    });
    const view = render(<ControlledComposer props={props} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    await screen.findByText("Microphone permission denied. Text input is still available.");

    const editor = screen.getByRole("textbox", { name: "Message Sentient" });
    fireEvent.input(editor, { target: { value: "draft survives" } });
    view.rerender(<ChatComposer {...props} connectionReady={false} value="draft survives" onValueChange={props.onValueChange} />);
    expect((screen.getByRole("textbox", { name: "Message Sentient" }) as HTMLTextAreaElement).value).toBe("draft survives");
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps capture intents semantic and commits a sustained Hold release", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const props = composerProps();
    render(<ChatComposer {...props} />);
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });

    fireEvent.pointerDown(primary, { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    await vi.runAllTimersAsync();
    vi.setSystemTime(new Date(300));
    fireEvent.pointerUp(primary, { pointerId: 7, clientX: 100, clientY: 100 });
    await vi.runAllTimersAsync();

    expect(props.onCaptureIntent).toHaveBeenNthCalledWith(1, { type: "start", mode: "hold" });
    expect(props.onCaptureIntent).toHaveBeenNthCalledWith(2, { type: "commit" });
  });

  it("offers Hold Cancel and keeps foreground Interrupt independent", async () => {
    const onCaptureIntent = vi.fn(async () => undefined);
    const onInterrupt = vi.fn();
    const props = composerProps({ cycleStatus: "streaming", onCaptureIntent, onInterrupt });
    render(<ChatComposer {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Start Hold voice capture" }));
    await screen.findByRole("button", { name: "Cancel voice message" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice message" }));
    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: "cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Start Hold voice capture" }));
    await screen.findByRole("button", { name: "Cancel voice message" });
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(onInterrupt).toHaveBeenCalledOnce();
  });

  it("does not show Interrupt for background-only awaiting tasks", () => {
    const background = {
      id: "background-1",
      toolName: "delegateTask",
      kind: "background" as const,
      status: "running" as const,
      argsPreview: "safe",
      startedAtMs: 1,
    };
    render(<ChatComposer {...composerProps({ cycleStatus: "awaiting-tasks", tasks: [background] })} />);
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
  });

  it("keeps a typed draft through Auto and finalizes on an explicit second activation", async () => {
    const props = composerProps();
    render(<ControlledComposer props={props} />);
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    fireEvent.click(primary);
    const auto = await screen.findByRole("button", { name: /Auto listening is on/ });

    const editor = screen.getByRole("textbox", { name: "Message Sentient" });
    fireEvent.input(editor, { target: { value: "typed while auto" } });
    fireEvent.click(auto, { detail: 1 });
    await waitFor(() => expect(props.onCaptureIntent).toHaveBeenCalledWith({ type: "commit" }));

    expect((screen.getByRole("textbox", { name: "Message Sentient" }) as HTMLTextAreaElement).value).toBe("typed while auto");
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("fences a release that arrives before Hold start resolves", async () => {
    let resolveStart: ((value: void | PromiseLike<void>) => void) | undefined;
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    const onCaptureIntent = vi.fn((intent: CaptureIntent) => intent.type === "start" ? startGate : undefined);
    const props = composerProps({ onCaptureIntent });
    render(<ChatComposer {...props} />);
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });

    fireEvent.pointerDown(primary, { button: 0, pointerId: 8, clientX: 20, clientY: 20 });
    fireEvent.pointerCancel(primary, { pointerId: 8, clientX: 20, clientY: 20 });
    resolveStart?.();
    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: "cancel" }));
    expect(onCaptureIntent.mock.calls.filter(([intent]) => intent.type === "cancel")).toHaveLength(1);
  });

  it("cancels an active capture on the external system edge without a duplicate intent", async () => {
    const props = composerProps();
    const view = render(<ChatComposer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    await screen.findByRole("button", { name: /Auto listening is on/ });

    view.rerender(<ChatComposer {...props} captureActive />);
    view.rerender(<ChatComposer {...props} captureActive={false} />);
    await screen.findByText("Voice capture cancelled by the system.");
    expect(props.onCaptureIntent).not.toHaveBeenCalledWith({ type: "cancel" });
    expect(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" })).toBeTruthy();
  });

  it("renders a full server-owned task shelf with one upward detail", () => {
    const props = composerProps({
      cycleStatus: "streaming",
      tasks: [
        { id: "one", toolName: "search_web", kind: "foreground", status: "running", argsPreview: "query: safe", startedAtMs: 1 },
        { id: "two", toolName: "play_music", kind: "foreground", status: "done", argsPreview: "title: song", startedAtMs: 2, endedAtMs: 3 },
      ],
    });
    render(<ChatComposer {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Task search_web" }));
    expect(screen.getByText(/safe/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Task search_web" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Task play_music" }));
    expect(screen.queryByText(/safe/)).toBeNull();
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeTruthy();
  });

  it("keeps disabled capture text-only and exposes permission/start errors", async () => {
    const disabledProps = composerProps({ connectionReady: false });
    const disabledView = render(<ChatComposer {...disabledProps} />);
    const unavailable = screen.getByRole("button", { name: "Voice unavailable while reconnecting" }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    fireEvent.click(unavailable);
    expect(disabledProps.onCaptureIntent).not.toHaveBeenCalled();
    disabledView.unmount();

    const failed = composerProps({ onCaptureIntent: vi.fn(async () => { throw new Error("no mic"); }) });
    const view = render(<ChatComposer {...failed} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    await screen.findByText("Microphone could not start. Text input is still available.");
    view.unmount();
  });

  it("serializes semantic Hold-to-Auto as one product intent", async () => {
    const onCaptureIntent = vi.fn(async (_intent: CaptureIntent) => undefined);
    const props = composerProps({ onCaptureIntent });
    render(<ChatComposer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Start Hold voice capture" }));
    const autoChoice = await screen.findByRole("button", { name: "Switch to Auto listening" });
    fireEvent.click(autoChoice);
    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: "auto" }));
    expect(onCaptureIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: "start", mode: "hold" },
      { type: "auto" },
    ]);
    expect(screen.getByRole("button", { name: /Auto listening is on/ })).toBeTruthy();
  });

  it("adapts the existing identified caller and serializes Hold-to-Auto before restart", async () => {
    const order: string[] = [];
    let releaseCommit: (() => void) | undefined;
    const onCaptureStart = vi.fn(async (mode: "manual" | "semantic") => {
      order.push(`start:${mode}`);
      return mode === "manual" ? "manual-1" : "semantic-1";
    });
    const onCaptureCommit = vi.fn((_id: string) => new Promise<void>((resolve) => {
      order.push("commit:manual-1");
      releaseCommit = resolve;
    }));
    const onCaptureCancel = vi.fn(async (_id: string) => undefined);
    const legacy = {
      cycleStatus: "idle" as const,
      connectionReady: true,
      captureActive: false,
      ttsEnabled: true,
      suggestions: [] as readonly string[],
      tasks: [],
      onSendText: vi.fn(),
      onCaptureStart,
      onCaptureCommit,
      onCaptureCancel,
      onTtsToggle: vi.fn(),
      onInterrupt: vi.fn(),
      onSuggestionClick: vi.fn(),
    };
    // The overload is the one compatibility seam; VoiceCaptureControl itself
    // remains an implementation detail of the composer.
    render(<ChatComposer {...legacy} />);
    fireEvent.click(screen.getByRole("button", { name: "Start Hold voice capture" }));
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Auto listening" }));
    await waitFor(() => expect(order).toEqual(["start:manual", "commit:manual-1"]));
    releaseCommit?.();
    await waitFor(() => expect(order).toEqual(["start:manual", "commit:manual-1", "start:semantic"]));
    expect(onCaptureStart).toHaveBeenCalledWith("semantic");
    expect(onCaptureCancel).not.toHaveBeenCalled();
  });

  it("does not let a fenced start reopen the control after reconnect", async () => {
    let resolveStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    const onCaptureIntent = vi.fn((intent: CaptureIntent) => intent.type === "start" ? startGate : undefined);
    const props = composerProps({ onCaptureIntent });
    const view = render(<ChatComposer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    view.rerender(<ChatComposer {...props} connectionReady={false} />);
    resolveStart?.();
    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: "cancel" }));
    expect(screen.getByRole("button", { name: "Voice unavailable while reconnecting" })).toBeTruthy();
  });
});

describe("pure VoiceCapture presentation mapping", () => {
  it.each(VOICE_CAPTURE_STATES)("maps %s without browser or connector state", (state) => {
    const presentation = mapVoiceCapturePresentation(state, false, true);
    expect(presentation.state).toBe(state);
    expect(presentation.live).toBe(isVoiceCaptureLive(state));
    expect(presentation.primaryLabel.length).toBeGreaterThan(0);
    expect(presentation.primaryPressed).toBe(state === "auto");
    expect(presentation.fanOpen).toBe(state === "hold");
  });

  it("maps disabled and error tones without changing capture state", () => {
    expect(mapVoiceCapturePresentation("idle", true, false)).toMatchObject({ disabled: true, tone: "disabled" });
    expect(mapVoiceCapturePresentation("permission-denied", false, false)).toMatchObject({ disabled: false, tone: "error" });
    expect(mapVoiceCapturePresentation("start-failed", false, false)).toMatchObject({ disabled: false, tone: "error" });
  });
});

describe("dock foundation boundary", () => {
  it("uses semantic foundation materials and responsive/reduced-motion rules", () => {
    expect(DOCK_STYLES).toContain("var(--slate-face)");
    expect(DOCK_STYLES).toContain("var(--slate-shadow)");
    expect(DOCK_STYLES).toContain("@media (max-width: 480px)");
    expect(DOCK_STYLES).toContain("@media (prefers-reduced-motion: reduce)");
    expect(DOCK_STYLES).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(DOCK_STYLES).not.toMatch(/\b(?:rgba?|hsla?)\s*\(/i);
  });
});
