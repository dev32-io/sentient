import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionButton } from "./foundation.tsx";
import { AsyncState, Notice, PaneChrome } from "./composites.tsx";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AsyncState loading", () => {
  it("names the loading status and keeps its progress cue decorative", () => {
    render(<AsyncState state="loading" title="Loading" message="Fetching current settings…" />);

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("heading", { name: "Loading" })).toBeTruthy();
    expect(screen.getByText("Fetching current settings…")).toBeTruthy();
    expect(status.querySelector(".snt-async-state__spinner")?.getAttribute("aria-hidden")).toBe("true");
    expect(status.querySelector("progress")).toBeNull();
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
