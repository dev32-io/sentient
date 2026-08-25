import { act, render, screen, waitFor } from "@testing-library/preact";
import type { StateMachineInput } from "@rive-app/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SentientIdentity, type RiveFactory } from "./sentient-identity.tsx";

class QueryList {
  matches: boolean;
  private listeners = new Set<() => void>();
  constructor(matches: boolean) { this.matches = matches; }
  addEventListener(_type: string, listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void): void { this.listeners.delete(listener); }
  set(matches: boolean): void { this.matches = matches; for (const listener of this.listeners) listener(); }
}

function input(name: string) {
  return { name, value: false, fire: vi.fn() };
}

function adapterFactory(inputs: ReturnType<typeof input>[]) {
  let configuration: Parameters<RiveFactory>[0] | undefined;
  const cleanup = vi.fn();
  const resize = vi.fn();
  const factory: RiveFactory = (next) => {
    configuration = next;
    return { stateMachineInputs: () => inputs as unknown as StateMachineInput[], cleanup, resizeDrawingSurfaceToCanvas: resize };
  };
  return { factory, get configuration() { return configuration; }, cleanup, resize };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SentientIdentity", () => {
  it("maps only the latest semantic state and Reduced Motion into the Avatar machine", async () => {
    const query = new QueryList(true);
    vi.stubGlobal("matchMedia", () => query);
    const inputs = [input("reducedMotion"), input("toIdle"), input("toThinking"), input("toResponding")];
    const harness = adapterFactory(inputs);
    const view = render(<SentientIdentity state="thinking" riveFactory={harness.factory} />);
    view.rerender(<SentientIdentity state="responding" riveFactory={harness.factory} />);
    view.rerender(<SentientIdentity state="idle" riveFactory={harness.factory} />);

    expect(harness.configuration?.artboard).toBe("SentientAvatar");
    expect(harness.configuration?.stateMachines).toBe("Avatar");
    await act(async () => harness.configuration?.onLoad());
    await waitFor(() => expect(inputs[1]?.fire).toHaveBeenCalledTimes(1));
    expect(inputs[0]?.value).toBe(true);
    expect(inputs[2]?.fire).not.toHaveBeenCalled();
    expect(inputs[3]?.fire).not.toHaveBeenCalled();

    view.rerender(<SentientIdentity state="responding" riveFactory={harness.factory} />);
    expect(inputs[3]?.fire).toHaveBeenCalledTimes(1);
    act(() => query.set(false));
    expect(inputs[0]?.value).toBe(false);
    expect(inputs[3]?.fire).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
  });

  it("renders the packaged static mark and keeps native status text when Rive fails", async () => {
    vi.stubGlobal("matchMedia", () => new QueryList(false));
    const harness = adapterFactory([]);
    render(<SentientIdentity state="thinking" label="Assistant" riveFactory={harness.factory} />);
    act(() => harness.configuration?.onLoadError());
    expect(await screen.findByRole("status", { name: "Assistant is thinking" })).toBeTruthy();
    expect(document.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe("/sentient-mark.svg");
  });
});
