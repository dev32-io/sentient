import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionButton, ToggleControl } from "./foundation.tsx";
import { AsyncState, Notice, PaneChrome, SettingsCard, SettingsEditor, SettingsGroup, SettingsRow, ValidatedField } from "./composites.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("SettingsGroup", () => {
  it("keeps card heading and description semantics around labelled native controls", () => {
    render(
      <SettingsCard title="Reply output" subtitle="Choose how replies are delivered." padded={false}>
        <SettingsGroup>
          <SettingsRow label="Speak responses" hint="Replies can include audio.">
            <ToggleControl label="Speak responses" checked onChange={vi.fn()} />
          </SettingsRow>
        </SettingsGroup>
      </SettingsCard>,
    );

    expect(screen.getByRole("heading", { level: 3, name: "Reply output" })).toBeTruthy();
    expect(screen.getByText("Choose how replies are delivered.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Speak responses" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Speak responses" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("AsyncState", () => {
  it("names the loading status and keeps its progress cue decorative", () => {
    render(<AsyncState state="loading" title="Loading" message="Fetching current settings…" />);

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("heading", { name: "Loading" })).toBeTruthy();
    expect(screen.getByText("Fetching current settings…")).toBeTruthy();
    expect(status.querySelector(".snt-async-state__spinner")?.getAttribute("aria-hidden")).toBe("true");
    expect(status.querySelector("progress")).toBeNull();
  });

  it("gives empty content a decorative mark while preserving caller-owned copy and action", () => {
    const onAdd = vi.fn();
    render(
      <AsyncState
        state="empty"
        title="Nothing here yet"
        message="Add an item when you’re ready."
        action={<ActionButton variant="quiet" onClick={onAdd}>Add item</ActionButton>}
      />,
    );

    const status = screen.getByRole("status");
    expect(status.getAttribute("data-state")).toBe("empty");
    expect(status.querySelector(".snt-async-state__mark")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("heading", { level: 3, name: "Nothing here yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("keeps errors visually and semantically distinct from empty content", () => {
    render(<AsyncState state="error" title="Couldn’t load items" />);

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-state")).toBe("error");
    expect(alert.querySelector(".snt-async-state__mark")).toBeNull();
  });
});

describe("Notice", () => {
  it("keeps semantic announcements and exposes a separate action target", () => {
    render(
      <Notice
        tone="warning"
        title="Permission required"
        action={<ActionButton variant="quiet">Review</ActionButton>}
      >
        Review the requested scope before continuing.
      </Notice>,
    );

    const notice = screen.getByRole("status");
    expect(notice.classList.contains("snt-notice--warning")).toBe(true);
    expect(screen.getByText("Permission required").tagName).toBe("STRONG");
    expect(screen.getByText("Review the requested scope before continuing.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
    expect(notice.querySelector(".snt-notice__icon")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps errors assertive while info remains polite", () => {
    const { rerender } = render(<Notice tone="info">An informational update.</Notice>);
    expect(screen.getByRole("status")).toBeTruthy();

    rerender(<Notice tone="error">Something failed.</Notice>);
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("PaneChrome", () => {
  it("preserves the pane heading hierarchy and caller-owned action", () => {
    const onSave = vi.fn();
    render(
      <PaneChrome
        eyebrow="Household"
        title="Preferences"
        subtitle="Control shared defaults and personal behavior."
        action={<button type="button" onClick={onSave}>Save changes</button>}
      >
        <p>Pane content</p>
      </PaneChrome>,
    );

    const heading = screen.getByRole("heading", { level: 2, name: "Preferences" });
    expect(heading.closest("header")?.className).toBe("snt-pane-head");
    expect(screen.getByText("Household").className).toBe("snt-pane-head__eyebrow");
    expect(screen.getByText("Control shared defaults and personal behavior.").className).toBe("snt-page-subtitle");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("keeps the trailing action slot when copy is omitted", () => {
    render(<PaneChrome action={<button type="button">Add item</button>}>{null}</PaneChrome>);

    const header = document.querySelector(".snt-pane-head");
    expect(header?.firstElementChild?.className).toBe("snt-pane-head__copy");
    expect(screen.getByRole("button", { name: "Add item" })).toBeTruthy();
  });
});

describe("SettingsEditor", () => {
  it("derives its visible status without taking ownership of editor actions", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <SettingsEditor title="Instructions" dirty footer={<ActionButton onClick={onSave}>Save</ActionButton>}>
        <textarea aria-label="Instructions body" />
      </SettingsEditor>,
    );

    expect(screen.getByRole("status", { name: "Unsaved" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);

    rerender(<SettingsEditor title="Instructions" dirty={false}><textarea aria-label="Instructions body" /></SettingsEditor>);
    expect(screen.getByRole("status", { name: "Saved" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("ValidatedField", () => {
  it("preserves the labelled native input API and announces error status", () => {
    const onInput = vi.fn();
    render(
      <ValidatedField
        id="confirmation"
        label="Confirmation"
        value="warm emb"
        autoComplete="off"
        inputMode="text"
        error="The values do not match."
        onInput={onInput}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Confirmation" }) as HTMLInputElement;
    const label = screen.getByText("Confirmation") as HTMLLabelElement;
    const status = screen.getByRole("alert");

    expect(input.id).toBe("confirmation");
    expect(label.htmlFor).toBe(input.id);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("confirmation-error");
    expect(status.id).toBe("confirmation-error");
    expect(status.textContent).toContain("The values do not match.");
    expect(input.autocomplete).toBe("off");

    fireEvent.input(input, { target: { value: "warm ember" } });
    expect(onInput).toHaveBeenCalledTimes(1);
    input.focus();
    expect(document.activeElement).toBe(input);
  });

  it("renders valid feedback with a polite live status and the source association", () => {
    render(
      <ValidatedField
        id="recovery-phrase"
        label="Recovery phrase"
        value="warm ember"
        status={{ tone: "valid", message: "Available" }}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Recovery phrase" });
    const status = screen.getByRole("status", { name: "Available" });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe("recovery-phrase-status");
    expect(status.id).toBe("recovery-phrase-status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("renders a native multiline counter without linking it as a description", () => {
    render(
      <ValidatedField
        multiline
        label="Supporting note"
        value="A concise note that helps others understand this choice."
        maxLength={160}
        counter={{ current: 58, max: 160, unit: "characters" }}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "Supporting note" }) as HTMLTextAreaElement;
    const counter = screen.getByRole("status", { name: "58 of 160 characters" });
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.maxLength).toBe(160);
    expect(textarea.getAttribute("aria-invalid")).toBeNull();
    expect(textarea.getAttribute("aria-describedby")).toBeNull();
    expect(counter.id).toBe("");
    expect(counter.getAttribute("aria-live")).toBe("polite");
  });
});
