import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerProps } from "./composer.tsx";
import { VoiceCaptureControl } from "./voice-capture-control.tsx";

function composerProps(overrides: Partial<ChatComposerProps> = {}): ChatComposerProps {
  return {
    cycleStatus: "idle",
    connectionReady: true,
    captureActive: false,
    ttsEnabled: true,
    suggestions: [],
    tasks: [],
    onSendText: vi.fn(),
    onCaptureStart: vi.fn(async (mode) => mode === "manual" ? "manual-1" : "semantic-1"),
    onCaptureCommit: vi.fn(async () => undefined),
    onCaptureCancel: vi.fn(async () => undefined),
    onTtsToggle: vi.fn(),
    onInterrupt: vi.fn(),
    onSuggestionClick: vi.fn(),
    ...overrides,
  };
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

describe("ChatComposer text and server state boundary", () => {
  it("sends trimmed text on Enter and keeps Shift+Enter as a newline", () => {
    const props = composerProps();
    render(<ChatComposer {...props} />);
    const editor = screen.getByRole("textbox", { name: "Message Sentient" });
    fireEvent.input(editor, { target: { value: "  hello  " } });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(props.onSendText).not.toHaveBeenCalled();
    fireEvent.input(editor, { target: { value: "  hello\nthere  " } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(props.onSendText).toHaveBeenCalledWith("hello\nthere");
    expect((editor as HTMLTextAreaElement).value).toBe("");
    expect(document.activeElement).toBe(editor);
  });

  it("keeps text usable across reconnect and capture permission failure", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    const props = composerProps({ onCaptureStart: vi.fn(async () => { throw denied; }) });
    const view = render(<ChatComposer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    await screen.findByText("Microphone permission denied. Text input is still available.");
    const editor = screen.getByRole("textbox", { name: "Message Sentient" });
    fireEvent.input(editor, { target: { value: "draft survives" } });
    view.rerender(<ChatComposer {...props} connectionReady={false} />);
    expect((editor as HTMLTextAreaElement).value).toBe("draft survives");
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders one server-owned task detail and keeps Interrupt foreground-only", () => {
    const props = composerProps({
      cycleStatus: "streaming",
      tasks: [
        { id: "one", toolName: "search_web", kind: "foreground", status: "running", argsPreview: "query: safe", startedAtMs: 1 },
        { id: "two", toolName: "play_music", kind: "foreground", status: "done", argsPreview: "title: song", startedAtMs: 2, endedAtMs: 3 },
      ],
    });
    render(<ChatComposer {...props} />);
    fireEvent.click(screen.getByText("search_web"));
    expect(screen.getByText(/safe/)).toBeTruthy();
    fireEvent.click(screen.getByText("play_music"));
    expect(screen.queryByText(/safe/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(props.onInterrupt).toHaveBeenCalledOnce();
    expect(props.tasks).toHaveLength(2);
  });

  it("pins 44px targets, narrow layout, native v2 materials, and Reduced Motion", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/components.css"), "utf8");
    expect(css).toContain("ChatComposer v2 composite");
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("var(--slate-face)");
  });
});

describe("VoiceCaptureControl identified transitions", () => {
  function setup(overrides: Partial<Parameters<typeof VoiceCaptureControl>[0]> = {}) {
    let next = 0;
    const props = {
      disabled: false,
      captureActive: false,
      onStart: vi.fn(async () => `capture-${++next}`),
      onCommit: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
      ...overrides,
    };
    return { ...render(<VoiceCaptureControl {...props} />), props };
  }

  async function startPointerHold(button: HTMLElement): Promise<void> {
    fireEvent.pointerDown(button, { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    await waitFor(() => expect(button.closest("[data-state]")?.getAttribute("data-state")).toBe("hold"));
  }

  it("commits a sustained Hold release and cancels pointercancel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const first = setup();
    const button = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    fireEvent.pointerDown(button, { button: 0, pointerId: 7, clientX: 100, clientY: 100 });
    await vi.advanceTimersByTimeAsync(300);
    fireEvent.pointerUp(button, { pointerId: 7, clientX: 100, clientY: 100 });
    await vi.runAllTimersAsync();
    expect(first.props.onCommit).toHaveBeenCalledWith("capture-1");

    first.unmount();
    const second = setup();
    const nextButton = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    fireEvent.pointerDown(nextButton, { button: 0, pointerId: 8, clientX: 10, clientY: 10 });
    await vi.advanceTimersByTimeAsync(1);
    fireEvent.pointerCancel(nextButton, { pointerId: 8, clientX: 10, clientY: 10 });
    await vi.runAllTimersAsync();
    expect(second.props.onCancel).toHaveBeenCalledWith("capture-1");
  });

  it("orders Hold commit before opening a fresh Auto identity", async () => {
    let releaseCommit: (() => void) | undefined;
    const order: string[] = [];
    let next = 0;
    const control = setup({
      onStart: vi.fn(async (mode) => { order.push(`start:${mode}`); return `capture-${++next}`; }),
      onCommit: vi.fn((id) => new Promise<void>((resolve) => { order.push(`commit:${id}`); releaseCommit = resolve; })),
    });
    const button = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    await startPointerHold(button);
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Auto listening" }));
    await waitFor(() => expect(order).toEqual(["start:manual", "commit:capture-1"]));
    releaseCommit?.();
    await waitFor(() => expect(order).toEqual(["start:manual", "commit:capture-1", "start:semantic"]));
    expect(control.props.onStart).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /Auto listening is on/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("finalizes active Auto and ignores stale terminal actions", async () => {
    const control = setup();
    const button = screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" });
    fireEvent.click(button);
    const auto = await screen.findByRole("button", { name: /Auto listening is on/ });
    fireEvent.click(auto);
    fireEvent.click(auto);
    await waitFor(() => expect(control.props.onCommit).toHaveBeenCalledTimes(1));
    expect(control.props.onCommit).toHaveBeenCalledWith("capture-1");
  });

  it("offers keyboard Hold/Send/Cancel/Auto controls and discards on teardown", async () => {
    const control = setup();
    fireEvent.click(screen.getByRole("button", { name: "Start Hold voice capture" }));
    expect(await screen.findByRole("button", { name: "Send voice message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel voice message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch to Auto listening" })).toBeTruthy();
    control.unmount();
    await waitFor(() => expect(control.props.onCancel).toHaveBeenCalledWith("capture-1"));
  });

  it("mirrors system cancellation without emitting a second terminal", async () => {
    const control = setup();
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    await screen.findByRole("button", { name: /Auto listening is on/ });
    control.rerender(<VoiceCaptureControl {...control.props} captureActive />);
    control.rerender(<VoiceCaptureControl {...control.props} captureActive={false} />);
    await screen.findByText("Voice capture cancelled by the system.");
    expect(control.props.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" })).toBeTruthy();
  });

  it("disables during reconnect and cancels the current capture", async () => {
    const control = setup();
    fireEvent.click(screen.getByRole("button", { name: "Tap for Auto listening or hold to talk" }));
    await screen.findByRole("button", { name: /Auto listening is on/ });
    control.rerender(<VoiceCaptureControl {...control.props} disabled />);
    await waitFor(() => expect(control.props.onCancel).toHaveBeenCalledWith("capture-1"));
    expect((screen.getByRole("button", { name: "Voice unavailable while reconnecting" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
