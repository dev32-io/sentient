import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { Select } from "./select.tsx";
import { Textarea } from "./textarea.tsx";

describe("settings compatibility controls", () => {
  it("forwards textarea monospace and dirty semantics", () => {
    render(<Textarea value="draft" onChange={() => {}} monospace dirty />);
    const textarea = screen.getByRole("textbox");
    expect(textarea.classList.contains("snt-textarea--mono")).toBe(true);
    expect(textarea.classList.contains("snt-textarea--dirty")).toBe(true);
    expect(textarea.getAttribute("data-dirty")).toBe("true");
  });

  it("exposes listbox options and supports arrows, Home/End, selection, and focus restoration", async () => {
    const onChange = vi.fn();
    render(<Select value="b" onChange={onChange} options={[
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma" },
    ]} />);
    const trigger = screen.getByRole("button", { name: /Beta/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await Promise.resolve();

    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Beta" }));

    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Gamma" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Alpha" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Gamma" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    await Promise.resolve();

    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Escape closes the listbox and restores trigger focus", async () => {
    render(<Select value="a" onChange={() => {}} options={[{ value: "a", label: "Alpha" }]} />);
    const trigger = screen.getByRole("button", { name: /Alpha/ });
    fireEvent.keyDown(trigger, { key: " " });
    // Space activation remains native click behavior; ArrowDown is the explicit keyboard opener.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await Promise.resolve();
    fireEvent.keyDown(screen.getByRole("option"), { key: "Escape" });
    await Promise.resolve();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
