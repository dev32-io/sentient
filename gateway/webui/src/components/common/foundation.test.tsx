import { fireEvent, render, screen } from "@testing-library/preact";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinEntry, SearchFilterBar, WipBadge } from "./composites.tsx";
import { ActionButton, CheckboxControl, Field, SelectControl, TextField, ToggleControl } from "./foundation.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Web foundation controls", () => {
  it("uses native semantics for fields, selects, switches, and checkboxes", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const onCheck = vi.fn();
    render(<div>
      <Field label="Name" hint="Household name" error="Required" value="" />
      <SelectControl label="Voice" value="a" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange={onSelect} />
      <ToggleControl label="Announcements" checked={false} onChange={onToggle} />
      <CheckboxControl label="Remember me" checked={false} onChange={onCheck} />
    </div>);

    const field = screen.getByRole("textbox", { name: "Name" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain("error");
    fireEvent.change(screen.getByRole("combobox", { name: "Voice" }), { target: { value: "b" } });
    expect(onSelect).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("switch", { name: "Announcements" }));
    expect(onToggle).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember me" }));
    expect(onCheck).toHaveBeenCalledWith(true);
  });

  it("exposes loading and disabled action states without changing its label", () => {
    render(<ActionButton loading>Save changes</ActionButton>);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("delegates adorned fields and badges to shared semantic primitives", () => {
    render(<div><TextField value="draft" prefix="ID" suffix=".local" invalid /><WipBadge /></div>);
    expect(screen.getByRole("textbox").classList.contains("snt-input-group__input")).toBe(true);
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("In progress").classList.contains("snt-wip-badge")).toBe(true);
  });

  it("supports PIN keyboard movement and a labelled native search", () => {
    const onChange = vi.fn();
    render(<div><PinEntry value="1" onChange={onChange} /><SearchFilterBar value="" onChange={vi.fn()} /></div>);
    const second = screen.getByLabelText("PIN digit 2");
    second.focus();
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByLabelText("PIN digit 1"));
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeTruthy();
  });

  it("pins coarse-pointer targets, narrow reflow, Reduced Motion, and generated material recipes", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/common/foundation.css"), "utf8");
    expect(css).toContain("(pointer: coarse)");
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    for (const role of ["--slate-face", "--well-face", "--plate-shadow", "--float-shadow"]) expect(css).toContain(`var(${role})`);
  });
});
