import { act, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../../hooks/use-toast.tsx";
import { ToastHost } from "./toast.tsx";

function ToastHarness() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.show("Changes saved", "success", "Your preference is up to date.")}>Show toast</button>
      <ToastHost />
    </>
  );
}

describe("ToastHost", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("announces the owned message and preserves dedicated and timed dismissal", () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.textContent).toContain("Changes saved");
    expect(status.textContent).toContain("Your preference is up to date.");
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeTruthy();

    fireEvent.click(status);
    expect(screen.getByRole("status")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(4000); });
    expect(screen.getByRole("status").classList.contains("toast--closing")).toBe(true);

    act(() => { vi.advanceTimersByTime(150); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("starts the same exit when the dedicated dismiss control is activated", () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show toast" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.getByRole("status").classList.contains("toast--closing")).toBe(true);
  });
});
