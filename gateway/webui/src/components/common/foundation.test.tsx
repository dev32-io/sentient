import { fireEvent, render, screen } from "@testing-library/preact";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinEntry, SearchFilterBar, WipBadge } from "./composites.tsx";
import { ActionButton, CheckboxControl, ChipControl, Field, Plate, SegmentedControl, SelectControl, SliderControl, TextArea, TextField, ToggleControl } from "./foundation.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const FOUNDATION_ENTRY_PATH = resolve(process.cwd(), "src/components/common/foundation.css");

function readFoundationEntry(): string {
  return readFileSync(FOUNDATION_ENTRY_PATH, "utf8");
}

function readFoundationCss(): string {
  return readFoundationEntry().replace(/@import\s+["']([^"']+)["'];?/g, (_, importPath: string) => readFileSync(resolve(dirname(FOUNDATION_ENTRY_PATH), importPath), "utf8"));
}

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

  it("synchronizes mixed state through the native checkbox property", () => {
    render(<CheckboxControl label="Some items" checked={false} indeterminate onChange={vi.fn()} />);

    const checkbox = screen.getByRole("checkbox", { name: "Some items" }) as HTMLInputElement;
    expect(checkbox.indeterminate).toBe(true);
    expect(checkbox.disabled).toBe(false);
  });

  it("keeps SegmentedControl controlled, native, and disabled per option", () => {
    const onChange = vi.fn();
    const options = [
      { value: "comfortable", label: "Comfortable" },
      { value: "compact", label: "Compact" },
      { value: "unavailable", label: "Unavailable", disabled: true },
    ] as const;
    const { rerender } = render(<SegmentedControl label="View density" value="comfortable" options={options} onChange={onChange} />);

    const group = screen.getByRole("group", { name: "View density" });
    const buttons = [...group.querySelectorAll("button")] as HTMLButtonElement[];
    const comfortable = buttons[0];
    const compact = buttons[1];
    const unavailable = buttons[2];
    if (!comfortable || !compact || !unavailable) throw new Error("SegmentedControl did not render all options");
    expect(buttons).toHaveLength(3);
    expect(comfortable.type).toBe("button");
    expect(comfortable.getAttribute("aria-pressed")).toBe("true");
    expect(compact.getAttribute("aria-pressed")).toBe("false");
    expect(compact.disabled).toBe(false);
    expect(unavailable.disabled).toBe(true);

    compact.click();
    expect(onChange).toHaveBeenCalledWith("compact");
    unavailable.click();
    expect(onChange).toHaveBeenCalledTimes(1);

    rerender(<SegmentedControl label="View density" value="compact" options={options} onChange={onChange} disabled />);
    const disabledComfortable = screen.getByRole("button", { name: "Comfortable" }) as HTMLButtonElement;
    const selectedCompact = screen.getByRole("button", { name: "Compact" }) as HTMLButtonElement;
    expect(disabledComfortable.disabled).toBe(true);
    expect(disabledComfortable.getAttribute("aria-pressed")).toBe("false");
    expect(selectedCompact.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the plain Field native, labelled, editable, and focusable", () => {
    const onInput = vi.fn();
    render(<Field label="Display name" value="Maya Chen" onInput={onInput} />);

    const input = screen.getByRole("textbox", { name: "Display name" });
    const label = screen.getByText("Display name");
    expect(input.classList.contains("snt-input")).toBe(true);
    expect(input.id).not.toBe("");
    expect((label as HTMLLabelElement).htmlFor).toBe(input.id);
    expect((input as HTMLInputElement).value).toBe("Maya Chen");

    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: "Ada Lovelace" } });
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("keeps TextArea native, labelled, multiline, and stateful", () => {
    const onInput = vi.fn();
    render(<TextArea
      label="Description"
      hint="Supporting details"
      error="Required"
      value="Add supporting details."
      rows={5}
      monospace
      dirty
      onInput={onInput}
    />);

    const textarea = screen.getByRole("textbox", { name: "Description" });
    const label = screen.getByText("Description");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.id).not.toBe("");
    expect((label as HTMLLabelElement).htmlFor).toBe(textarea.id);
    expect((textarea as HTMLTextAreaElement).value).toBe("Add supporting details.");
    expect((textarea as HTMLTextAreaElement).rows).toBe(5);
    expect(textarea.getAttribute("aria-describedby")).toContain(`${textarea.id}-hint`);
    expect(textarea.getAttribute("aria-describedby")).toContain(`${textarea.id}-error`);
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.classList.contains("snt-textarea")).toBe(true);
    expect(textarea.classList.contains("snt-textarea--mono")).toBe(true);
    expect(textarea.classList.contains("snt-textarea--dirty")).toBe(true);
    expect(textarea.getAttribute("data-dirty")).toBe("true");

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    fireEvent.input(textarea, { target: { value: "Updated details." } });
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("keeps the search-field authority on a labelled native search Field", () => {
    const onInput = vi.fn();
    render(<Field label="Search" type="search" value="" placeholder="Search conversations" onInput={onInput} />);

    const input = screen.getByRole("searchbox", { name: "Search" });
    const label = screen.getByText("Search");
    expect(input.classList.contains("snt-input")).toBe(true);
    expect((input as HTMLInputElement).type).toBe("search");
    expect((input as HTMLInputElement).placeholder).toBe("Search conversations");
    expect((label as HTMLLabelElement).htmlFor).toBe(input.id);
    expect(input.closest(".snt-search")).toBeNull();
    expect(input.parentElement?.querySelector("svg")).toBeNull();

    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: "Ada" } });
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("keeps Plate semantic and compatible with caller classes", () => {
    render(<Plate className="qa-plate"><span>Plate content</span></Plate>);
    const plate = screen.getByText("Plate content").closest("section");
    expect(plate).not.toBeNull();
    expect(plate?.className).toBe("snt-plate qa-plate");
  });

  it("keeps SliderControl native, labelled, controlled, and value-visible", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SliderControl
        label="Interface scale"
        value={62}
        min={0}
        max={100}
        format={(value) => `${Math.round(value)}%`}
        onChange={onChange}
      />,
    );

    const slider = screen.getByRole("slider", { name: "Interface scale" }) as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("100");
    expect(slider.value).toBe("62");
    expect(slider.getAttribute("aria-label")).toBe("Interface scale");
    expect(screen.getByText("62%").tagName).toBe("OUTPUT");

    fireEvent.input(slider, { target: { value: "75" } });
    expect(onChange).toHaveBeenCalledWith(75);

    rerender(
      <SliderControl
        label="Interface scale"
        value={75}
        min={0}
        max={100}
        format={(value) => `${Math.round(value)}%`}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("75%")).toBeTruthy();
  });

  it("exposes loading and disabled action states without changing its label", () => {
    render(<ActionButton loading>Save changes</ActionButton>);
    const button = screen.getByRole("button", { name: "Save changes" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("keeps ChipControl controlled, native, and pressed-state accessible", () => {
    const onClick = vi.fn();
    render(<div><ChipControl selected onClick={onClick}>Family</ChipControl><ChipControl disabled>Unavailable</ChipControl></div>);

    const chip = screen.getByRole("button", { name: "Family" }) as HTMLButtonElement;
    expect(chip.type).toBe("button");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.disabled).toBe(false);
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);

    const unavailable = screen.getByRole("button", { name: "Unavailable" }) as HTMLButtonElement;
    expect(unavailable.disabled).toBe(true);
    expect(unavailable.getAttribute("aria-pressed")).toBe("false");
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

  it("keeps focused stylesheets in their compatibility cascade order", () => {
    const imports = [...readFoundationEntry().matchAll(/@import\s+["']([^"']+)["'];?/g)].map((match) => match[1]);
    expect(imports).toEqual([
      "./foundation/surfaces.css",
      "./foundation/buttons.css",
      "./foundation/fields.css",
      "./foundation/controls.css",
      "./foundation/identity.css",
      "./foundation/responsive.css",
      "./foundation/extensions.css",
      "./foundation/fields-extensions.css",
      "./foundation/controls-extensions.css",
      "./foundation/compositions.css",
      "./foundation/search.css",
      "./foundation/status.css",
      "./foundation/responsive-extensions.css",
      "./foundation/surface-extensions.css",
      "./foundation/select-menu.css",
      "./foundation/focus.css",
    ]);
  });

  it("pins coarse-pointer targets, narrow reflow, Reduced Motion, and generated material recipes", () => {
    const css = readFoundationCss();
    expect(css).toContain("(pointer: coarse)");
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    for (const role of ["--slate-face", "--well-face", "--plate-shadow", "--float-shadow"]) expect(css).toContain(`var(${role})`);
    expect(css).toContain(":is(.snt-button, .snt-icon-button");
    expect(css).toContain("var(--slate-base, var(--color-paper))");
  });
});
