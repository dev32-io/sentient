import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerGlyph, type ComposerGlyphName } from "./composer-glyph.tsx";
import { DOCK_STYLES, DockStyleSheet } from "./dock-styles.tsx";
import { type CaptureIntent, ChatComposer, type ChatComposerProps } from "./index.ts";
import { VoiceCaptureControl } from "./voice-capture-control.tsx";
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

function mockRect(element: Element, left: number, top: number, width: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect);
}

function firePointer(
  element: Element,
  type: "PointerDown" | "PointerMove" | "PointerUp",
  init: { pointerId: number; clientX: number; clientY: number; button?: number },
): void {
  // happy-dom does not expose onpointer* properties, so Preact registers these
  // listeners with the JSX casing rather than the browser's lowercase casing.
  const event = createEvent(type, element, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId },
  });
  fireEvent(element, event);
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

  it("lets the composer face own textarea focus and moves the caret to the draft end", () => {
    const props = composerProps({ value: "draft text" });
    render(<ChatComposer {...props} />);
    const editor = screen.getByRole("textbox", { name: "Message Sentient" }) as HTMLTextAreaElement;
    const surface = editor.closest(".dock-composer__surface") as HTMLElement;
    editor.setSelectionRange(0, 0);

    fireEvent.pointerDown(surface, { button: 0, pointerId: 3 });

    expect(document.activeElement).toBe(editor);
    expect(editor.parentElement).toBe(surface);
    expect(editor.selectionStart).toBe(editor.value.length);
    expect(editor.selectionEnd).toBe(editor.value.length);
  });

  it("separates pointer voice focus from intentional textarea focus during Auto", async () => {
    render(<ChatComposer {...composerProps()} />);
    const editor = screen.getByRole("textbox", { name: "Message Sentient" });
    const surface = editor.closest(".dock-composer__surface") as HTMLElement;
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    editor.focus();
    expect(surface.getAttribute("data-focus-origin")).toBe("intentional");

    firePointer(primary, "PointerDown", { button: 0, pointerId: 4, clientX: 20, clientY: 20 });
    firePointer(primary, "PointerUp", { pointerId: 4, clientX: 20, clientY: 20 });
    const auto = await screen.findByRole("button", { name: "Auto listening is on; activate to turn it off" });
    expect(document.activeElement).toBe(auto);
    expect(surface.getAttribute("data-focus-origin")).toBe("pointer-voice");

    fireEvent.pointerDown(editor, { button: 0, pointerId: 5 });
    editor.focus();
    expect(document.activeElement).toBe(editor);
    expect(surface.getAttribute("data-voice-state")).toBe("auto");
    expect(surface.getAttribute("data-focus-origin")).toBe("intentional");

    fireEvent.pointerDown(auto, { button: 0, pointerId: 6 });
    expect(surface.getAttribute("data-focus-origin")).toBe("pointer-voice");
    fireEvent.keyDown(auto, { key: "ArrowRight" });
    expect(surface.getAttribute("data-focus-origin")).toBe("intentional");
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

  it.each([
    { label: "Auto", x: 140, terminal: "auto" },
    { label: "Cancel", x: 220, terminal: "cancel" },
    { label: "Send", x: 300, terminal: "commit" },
  ] as const)("resolves a lower-pod drag through the $label horizontal region", async ({ label, x, terminal }) => {
    const onCaptureIntent = vi.fn(async (_intent: CaptureIntent) => undefined);
    render(<ChatComposer {...composerProps({ onCaptureIntent })} />);
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    const fan = document.querySelector(".dock-voice-capture__fan");
    if (!fan) throw new Error("Voice target crown not found");
    mockRect(fan, 100, 80, 240, 58);
    mockRect(primary, 100, 130, 240, 54);

    firePointer(primary, "PointerDown", { button: 0, pointerId: 9, clientX: 320, clientY: 160 });
    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: "start", mode: "hold" }));
    firePointer(primary, "PointerMove", { pointerId: 9, clientX: x, clientY: 160 });
    if (label !== "Send") await screen.findByText(`${label} selected.`);
    firePointer(primary, "PointerUp", { pointerId: 9, clientX: x, clientY: 160 });

    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: terminal }));
    expect(onCaptureIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: "start", mode: "hold" },
      { type: terminal },
    ]);
    const restored = screen.getByRole("button", {
      name: terminal === "auto" ? "Auto listening is on; activate to turn it off" : "Tap for Auto listening or hold to talk",
    });
    await waitFor(() => expect(document.activeElement).toBe(restored));
  });

  it("falls back to Send when a held pointer leaves the combined crown and pod", async () => {
    const onCaptureIntent = vi.fn(async (_intent: CaptureIntent) => undefined);
    render(<ChatComposer {...composerProps({ onCaptureIntent })} />);
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    const fan = document.querySelector(".dock-voice-capture__fan");
    if (!fan) throw new Error("Voice target crown not found");
    mockRect(fan, 100, 80, 240, 58);
    mockRect(primary, 100, 130, 240, 54);

    firePointer(primary, "PointerDown", { button: 0, pointerId: 10, clientX: 320, clientY: 160 });
    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: "start", mode: "hold" }));
    firePointer(primary, "PointerMove", { pointerId: 10, clientX: 60, clientY: 160 });
    firePointer(primary, "PointerUp", { pointerId: 10, clientX: 60, clientY: 160 });

    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: "commit" }));
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

  it("keeps keyboard Hold focus safe across an async start and exposes the crown in forward order", async () => {
    let resolveStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    const onCaptureIntent = vi.fn((intent: CaptureIntent) => intent.type === "start" ? startGate : undefined);
    render(<ChatComposer {...composerProps({ onCaptureIntent })} />);
    const hold = screen.getByRole("button", { name: "Start Hold voice capture" });
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });

    hold.focus();
    fireEvent.click(hold, { detail: 0 });
    await waitFor(() => expect(document.activeElement).toBe(primary));

    resolveStart?.();
    const send = await screen.findByRole("button", { name: "Send voice message" });
    const auto = screen.getByRole("button", { name: "Switch to Auto listening" });
    const cancel = screen.getByRole("button", { name: "Cancel voice message" });
    await waitFor(() => expect(document.activeElement).toBe(send));
    expect([...document.querySelectorAll<HTMLButtonElement>(".dock-voice-capture__choice")].map((choice) => choice.getAttribute("aria-label"))).toEqual([
      "Switch to Auto listening",
      "Cancel voice message",
      "Send voice message",
    ]);
    expect([auto.tabIndex, cancel.tabIndex, send.tabIndex]).toEqual([0, 0, 0]);

    fireEvent.keyDown(send, { key: "Tab" });
    expect(document.activeElement).toBe(auto);
    cancel.focus();
    fireEvent.click(cancel, { detail: 0 });

    await waitFor(() => expect(onCaptureIntent).toHaveBeenCalledWith({ type: "cancel" }));
    const restored = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    await waitFor(() => expect(document.activeElement).toBe(restored));
  });

  it("restores the primary control when an asynchronous keyboard Hold start fails", async () => {
    let rejectStart: ((reason?: unknown) => void) | undefined;
    const startGate = new Promise<void>((_resolve, reject) => { rejectStart = reject; });
    const onCaptureIntent = vi.fn((intent: CaptureIntent) => intent.type === "start" ? startGate : undefined);
    render(<ChatComposer {...composerProps({ onCaptureIntent })} />);
    const hold = screen.getByRole("button", { name: "Start Hold voice capture" });
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });

    hold.focus();
    fireEvent.click(hold, { detail: 0 });
    await waitFor(() => expect(document.activeElement).toBe(primary));
    rejectStart?.(new Error("capture unavailable"));

    await screen.findByText("Microphone could not start. Text input is still available.");
    await waitFor(() => expect(document.activeElement).toBe(primary));
    expect(document.querySelector(".dock-voice-capture__fan")?.getAttribute("aria-hidden")).toBe("true");
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

  it.each([
    { activation: "pointer", detail: 1 },
    { activation: "keyboard or assistive", detail: 0 },
  ])("turns Auto off without submitting buffered audio on $activation activation", async ({ detail }) => {
    const onCaptureIntent = vi.fn(async (_intent: CaptureIntent) => undefined);
    render(<ChatComposer {...composerProps({ onCaptureIntent })} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    const auto = await screen.findByRole("button", { name: "Auto listening is on; activate to turn it off" });

    if (detail === 1) {
      firePointer(auto, "PointerDown", { button: 0, pointerId: 17, clientX: 20, clientY: 20 });
      firePointer(auto, "PointerUp", { pointerId: 17, clientX: 20, clientY: 20 });
      fireEvent.click(auto, { detail });
    } else {
      auto.focus();
      fireEvent.keyDown(auto, { key: "Enter" });
      fireEvent.keyUp(auto, { key: "Enter" });
      fireEvent.click(auto, { detail });
    }

    await screen.findByText("Auto listening off.");
    expect(onCaptureIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { type: "start", mode: "auto" },
      { type: "cancel" },
    ]);
    expect(onCaptureIntent).not.toHaveBeenCalledWith({ type: "commit" });
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    await waitFor(() => expect(document.activeElement).toBe(primary));
  });

  it("keeps a typed draft when Auto is turned off", async () => {
    const props = composerProps();
    render(<ControlledComposer props={props} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    const auto = await screen.findByRole("button", { name: "Auto listening is on; activate to turn it off" });

    const editor = screen.getByRole("textbox", { name: "Message Sentient" });
    fireEvent.input(editor, { target: { value: "typed while auto" } });
    fireEvent.click(auto, { detail: 1 });
    await waitFor(() => expect(props.onCaptureIntent).toHaveBeenCalledWith({ type: "cancel" }));

    expect((screen.getByRole("textbox", { name: "Message Sentient" }) as HTMLTextAreaElement).value).toBe("typed while auto");
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("does not retain the native pointer event across asynchronous capture startup", async () => {
    let resolveStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => { resolveStart = resolve; });
    const onCaptureIntent = vi.fn((intent: CaptureIntent) => intent.type === "start" ? startGate : undefined);
    render(<ChatComposer {...composerProps({ onCaptureIntent })} />);
    const primary = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    const event = createEvent("PointerDown", primary, { bubbles: true, cancelable: true });
    let pointerIdReads = 0;
    Object.defineProperties(event, {
      button: { value: 0 },
      clientX: { value: 20 },
      clientY: { value: 20 },
      pointerId: { get: () => { pointerIdReads += 1; return 18; } },
    });

    fireEvent(primary, event);
    const synchronousReads = pointerIdReads;
    resolveStart?.();
    await waitFor(() => expect(primary.closest("[data-state]")?.getAttribute("data-state")).toBe("hold"));

    expect(pointerIdReads).toBe(synchronousReads);
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

  it("renders a full server-owned task shelf with accessible statuses and one upward detail", () => {
    const props = composerProps({
      cycleStatus: "streaming",
      tasks: [
        { id: "one", toolName: "search_web", kind: "foreground", status: "running", argsPreview: "query: safe", startedAtMs: 1 },
        { id: "two", toolName: "play_music", kind: "foreground", status: "done", argsPreview: "title: song", startedAtMs: 2, endedAtMs: 3 },
        { id: "three", toolName: "syncCalendar", kind: "background", status: "error", argsPreview: "calendar", startedAtMs: 4, endedAtMs: 5 },
      ],
    });
    render(<ChatComposer {...props} />);

    const running = screen.getByRole("button", { name: "Task Search web, running" });
    const done = screen.getByRole("button", { name: "Task Play music, done" });
    const failed = screen.getByRole("button", { name: "Task Sync Calendar, failed" });
    expect(running.querySelector(".dock-task-pill__dot--running")).toBeTruthy();
    expect(done.querySelector(".dock-task-pill__dot--done")).toBeTruthy();
    expect(failed.querySelector(".dock-task-pill__dot--error")).toBeTruthy();
    expect(running.querySelector(".dock-task-pill__status")?.textContent).toBe("running");
    expect(done.querySelector(".dock-task-pill__status")?.textContent).toBe("done");
    expect(failed.querySelector(".dock-task-pill__status")?.textContent).toBe("error");

    const detailSlot = document.querySelector(".dock-task-shelf__detail-slot");
    expect(detailSlot?.getAttribute("data-open")).toBe("false");

    fireEvent.click(running);
    expect(screen.getByText(/safe/)).toBeTruthy();
    expect(running.getAttribute("aria-expanded")).toBe("true");
    expect(detailSlot?.getAttribute("data-open")).toBe("true");
    fireEvent.click(done);
    expect(screen.queryByText(/safe/)).toBeNull();
    expect(screen.getByText(/song/)).toBeTruthy();
    expect(document.querySelectorAll(".tool-inline-detail")).toHaveLength(1);
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
    const primary = screen.getByRole("button", { name: "Auto listening is on; activate to turn it off" });
    expect(primary).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(primary));
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

  it("discards persistent Auto through the identified compatibility adapter", async () => {
    const onCaptureStart = vi.fn(async (_mode: "manual" | "semantic") => "semantic-1");
    const onCaptureCommit = vi.fn(async (_id: string) => undefined);
    const onCaptureCancel = vi.fn(async (_id: string) => undefined);
    render(
      <ChatComposer
        cycleStatus="idle"
        connectionReady
        captureActive={false}
        ttsEnabled
        suggestions={[]}
        tasks={[]}
        onSendText={vi.fn()}
        onCaptureStart={onCaptureStart}
        onCaptureCommit={onCaptureCommit}
        onCaptureCancel={onCaptureCancel}
        onTtsToggle={vi.fn()}
        onInterrupt={vi.fn()}
        onSuggestionClick={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }), { detail: 0 });
    const auto = await screen.findByRole("button", { name: "Auto listening is on; activate to turn it off" });
    fireEvent.click(auto, { detail: 0 });

    await waitFor(() => expect(onCaptureCancel).toHaveBeenCalledWith("semantic-1"));
    expect(onCaptureCommit).not.toHaveBeenCalled();
    expect(onCaptureStart).toHaveBeenCalledOnce();
    await screen.findByText("Auto listening off.");
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

  it("uses approved local glyphs across composer and voice states", async () => {
    const props = composerProps({ cycleStatus: "streaming" });
    const view = render(<ChatComposer {...props} />);
    expect(screen.getByRole("button", { name: "Attachments are not available" }).querySelector("path")?.getAttribute("d")).toBe(
      "m9 12 6-6a4 4 0 0 1 6 6l-8 8a6 6 0 0 1-8-8l8-8",
    );
    expect(screen.getByRole("button", { name: "Mute assistant voice" }).querySelector("path")?.getAttribute("d")).toBe(
      "M5 10v4h4l5 4V6l-5 4zM17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12",
    );
    expect(screen.getByRole("button", { name: "Interrupt" }).querySelector("rect")?.getAttribute("x")).toBe("7");
    expect(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }).querySelector("rect")?.getAttribute("x")).toBe("8");

    view.rerender(<ChatComposer {...props} ttsEnabled={false} value="draft" />);
    expect(screen.getByRole("button", { name: "Unmute assistant voice" }).querySelector("path")?.getAttribute("d")).toBe(
      "M5 10v4h4l5 4V6l-5 4zM3 3l18 18",
    );
    expect(screen.getByRole("button", { name: "Send message" }).querySelector("path")?.getAttribute("d")).toBe(
      "m4 4 17 8-17 8 3-8zM7 12h14",
    );

    view.rerender(<ChatComposer {...props} value="" />);
    fireEvent.click(screen.getByRole("button", { name: "Start Hold voice capture" }));
    await screen.findByRole("button", { name: "Cancel voice message" });
    const choices = [...document.querySelectorAll<HTMLButtonElement>(".dock-voice-capture__choice")];
    expect(choices.map((choice) => choice.querySelector("svg")?.getAttribute("width"))).toEqual(["18", "18", "18"]);
    expect(choices.map((choice) => choice.querySelector("path")?.getAttribute("d"))).toEqual([
      "M8 17a6 6 0 1 1 8 0M9 12h6M12 9v6M8 20h8",
      "m6 6 12 12M18 6 6 18",
      "m4 4 17 8-17 8 3-8zM7 12h14",
    ]);
  });

  it("injects dock styles once for the composer", () => {
    render(<ChatComposer {...composerProps()} />);
    expect(document.querySelectorAll("style[data-sentient-dock-style]")).toHaveLength(1);
  });

  it("shares one explicit dock style owner across standalone legacy voice controls", () => {
    const legacyProps = {
      disabled: false,
      captureActive: false,
      onStart: async () => "qa-capture",
      onCommit: async () => {},
      onCancel: async () => {},
    };

    render(
      <>
        <DockStyleSheet />
        <VoiceCaptureControl {...legacyProps} />
        <VoiceCaptureControl {...legacyProps} />
      </>,
    );

    expect(document.querySelectorAll("style[data-sentient-dock-style]")).toHaveLength(1);
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

  it("maps disabled, Auto, and error semantics without changing capture state", () => {
    expect(mapVoiceCapturePresentation("idle", true, false)).toMatchObject({ disabled: true, tone: "disabled" });
    expect(mapVoiceCapturePresentation("auto", false, false).primaryLabel).toBe("Auto listening is on; activate to turn it off");
    expect(mapVoiceCapturePresentation("permission-denied", false, false)).toMatchObject({ disabled: false, tone: "error" });
    expect(mapVoiceCapturePresentation("start-failed", false, false)).toMatchObject({ disabled: false, tone: "error" });
  });
});

describe("dock foundation boundary", () => {
  it("keeps pointer voice focus neutral while preserving intentional non-box focus emphasis", () => {
    expect(DOCK_STYLES).toMatch(/\.dock-composer__surface:focus-within:has\(:focus-visible\):not\(\[data-focus-origin="pointer-voice"\]\)\s*{/);
    expect(DOCK_STYLES).not.toMatch(/focus-within:has\(:focus-visible\):not\(\[data-voice-state=/);
    expect(DOCK_STYLES).not.toMatch(/\.dock-composer__surface:focus-within\s*{/);
    expect(DOCK_STYLES).toMatch(/\.snt-surface \.dock-composer-control:focus-visible\s*{[^}]*outline:/s);
    expect(DOCK_STYLES).toMatch(/\.snt-surface \.dock-voice-capture__choice:focus-visible\s*{[^}]*outline:/s);
    expect(DOCK_STYLES).toMatch(/\.snt-surface \.dock-voice-capture__primary:focus-visible\s*{[^}]*outline:\s*none;/s);
    expect(DOCK_STYLES).toMatch(/\.dock-voice-capture:has\(\.dock-voice-capture__primary:focus-visible\)::after\s*{[^}]*height:\s*3px;[^}]*background:\s*var\(--color-accent\);/s);
    expect(DOCK_STYLES).toMatch(/\[data-focus-origin="pointer-voice"\] \.dock-voice-capture:has\([^}]+\)::after\s*{[^}]*content:\s*none;/s);
    expect(DOCK_STYLES).toMatch(/@media \(forced-colors: active\)[\s\S]*?\.dock-voice-capture:has\([^}]+\)::after\s*{[^}]*background:\s*Highlight;[^}]*forced-color-adjust:\s*none;/s);
    expect(DOCK_STYLES).toMatch(/\.dock-composer__draft\s*{[^}]*field-sizing:\s*content;[^}]*background:\s*transparent;/s);
    expect(DOCK_STYLES).toMatch(/\.snt-surface \.dock-composer__draft:focus-visible\s*{[^}]*outline:\s*0;[^}]*box-shadow:\s*none;/s);
    expect(DOCK_STYLES).not.toMatch(/\.dock-composer__draft:focus-visible\s*{[^}]*outline:\s*var\(/s);
  });

  it("pins the approved composer-local 24px glyph geometry", () => {
    const expected: Record<ComposerGlyphName, { path?: string; rect?: readonly string[] }> = {
      attachment: { path: "m9 12 6-6a4 4 0 0 1 6 6l-8 8a6 6 0 0 1-8-8l8-8" },
      auto: { path: "M8 17a6 6 0 1 1 8 0M9 12h6M12 9v6M8 20h8" },
      cancel: { path: "m6 6 12 12M18 6 6 18" },
      mic: { path: "M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6", rect: ["8", "3", "8", "12", "4"] },
      send: { path: "m4 4 17 8-17 8 3-8zM7 12h14" },
      stop: { rect: ["7", "7", "10", "10", "2"] },
      volume: { path: "M5 10v4h4l5 4V6l-5 4zM17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" },
      "volume-off": { path: "M5 10v4h4l5 4V6l-5 4zM3 3l18 18" },
    };
    render(<div>{(Object.keys(expected) as ComposerGlyphName[]).map((name) => <span key={name} data-glyph={name}><ComposerGlyph name={name} /></span>)}</div>);

    for (const [name, geometry] of Object.entries(expected) as [ComposerGlyphName, (typeof expected)[ComposerGlyphName]][]) {
      const glyph = document.querySelector<SVGElement>(`[data-glyph="${name}"] svg`);
      expect(glyph?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(glyph?.getAttribute("stroke-width") ?? glyph?.getAttribute("strokeWidth")).toBe("1.7");
      if (geometry.path) expect(glyph?.querySelector("path")?.getAttribute("d")).toBe(geometry.path);
      if (geometry.rect) {
        const rect = glyph?.querySelector("rect");
        expect(["x", "y", "width", "height", "rx"].map((attribute) => rect?.getAttribute(attribute))).toEqual(geometry.rect);
      }
    }
  });

  it("keeps targeted crown leaves seated while retaining depressed activation", () => {
    expect(DOCK_STYLES).toMatch(/\.dock-voice-capture__choice\.is-selected\s*{[^}]*transform:\s*translateY\(0\) scale\(1\);/s);
    expect(DOCK_STYLES).not.toMatch(/\.dock-voice-capture__choice\.is-selected\s*{[^}]*translateY\(-/s);
    expect(DOCK_STYLES).not.toMatch(/\.dock-voice-capture__choice:hover/);
    expect(DOCK_STYLES).toMatch(/\.dock-voice-capture__choice:active\s*{[^}]*transform:\s*translateY\(1px\) scale\(0\.985\);/s);
    expect(DOCK_STYLES).toMatch(/\.dock-voice-capture__choice svg\s*{[^}]*width:\s*18px;[^}]*height:\s*18px;/s);
  });

  it("uses semantic foundation materials and responsive/reduced-motion rules", () => {
    expect(DOCK_STYLES).toContain("max-width: 900px");
    expect(DOCK_STYLES).toContain("--dock-target-size: 44px");
    expect(DOCK_STYLES).toContain("var(--slate-face)");
    expect(DOCK_STYLES).toContain("var(--slate-shadow)");
    expect(DOCK_STYLES).toContain("@media (max-width: 480px)");
    expect(DOCK_STYLES).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.dock-voice-capture\s*{[^}]*--dock-target-size:\s*48px;[^}]*--dock-live-height:\s*52px;[^}]*--dock-voice-width:\s*var\(--dock-live-width-narrow\);/);
    expect(DOCK_STYLES).toContain("@media (max-width: 380px)");
    expect(DOCK_STYLES).toContain("@media (max-width: 389px)");
    expect(DOCK_STYLES).toMatch(/@media \(max-width: 389px\)[\s\S]*?\.dock-composer__end-actions\s*{[^}]*grid-column:\s*1 \/ -1;/);
    expect(DOCK_STYLES).toContain("@media (prefers-reduced-motion: reduce)");
    expect(DOCK_STYLES).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(DOCK_STYLES).not.toMatch(/\b(?:rgba?|hsla?)\s*\(/i);
  });

  it("keeps active voice geometry definite while bounded by its parent", () => {
    expect(DOCK_STYLES).toMatch(/\.dock-voice-capture\s*{[^}]*max-width:\s*100%;/s);
    expect(DOCK_STYLES).toMatch(
      /\.dock-voice-capture:is\([^}]+\)\s*{[^}]*width:\s*var\(--dock-voice-width\);[^}]*flex-basis:\s*var\(--dock-voice-width\);/s,
    );
  });

  it("matches task activity motion and keeps a static reduced-motion signal", () => {
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__dot--running\s*{[^}]*background:\s*var\(--color-amber\);[^}]*animation:\s*dock-task-pulse 1\.45s ease-in-out infinite;/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__dot--done\s*{[^}]*background:\s*var\(--color-sage\);/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__dot--error\s*{[^}]*background:\s*var\(--color-stop\);/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-shelf__detail-slot\s*{[^}]*grid-template-rows:\s*0fr;[^}]*transition:/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-shelf__detail-slot\[data-open="true"\]\s*{[^}]*grid-template-rows:\s*1fr;/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill\s*{\s*animation:\s*dock-task-pill-enter 260ms cubic-bezier\(\.16, 1, \.3, 1\) backwards;/);
    expect(DOCK_STYLES).not.toMatch(/dock-task-pill-enter[^;]*\bboth\b/);
    expect(DOCK_STYLES).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dock-task-pill__dot--running,[\s\S]*?animation:\s*none;/);
    expect(DOCK_STYLES).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dock-task-pill__dot--running\s*{[^}]*box-shadow:\s*0 0 0 3px/s);
  });

  it("uses system-color shape, glyph, and label distinctions in Forced Colors", () => {
    expect(DOCK_STYLES).toMatch(/@media \(forced-colors: active\)\s*{/);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__dot\s*{[^}]*border:\s*2px solid CanvasText;[^}]*background:\s*Canvas;[^}]*color:\s*CanvasText;[^}]*forced-color-adjust:\s*none;/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__dot--running\s*{[^}]*border-radius:\s*50%;[^}]*background:\s*Highlight;[^}]*color:\s*HighlightText;/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__dot--done::after\s*{[^}]*content:\s*"✓";/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__dot--error\s*{[^}]*transform:\s*rotate\(45deg\);/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__dot--error::after\s*{[^}]*content:\s*"!";/s);
    expect(DOCK_STYLES).toMatch(/\.dock-task-pill__status\s*{[^}]*position:\s*static;[^}]*color:\s*CanvasText;/s);
  });
});
