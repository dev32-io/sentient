import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "preact/hooks";
import { Dialog } from "./dialog.tsx";

function resetDom(): void {
  document.body.innerHTML = "";
}

// jsdom permits focus inside inert trees; browsers intentionally reject it.
// Model that rule so a restore attempted before isolation release cannot pass.
beforeEach(() => {
  const nativeFocus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    let node: HTMLElement | null = this;
    while (node) {
      if (node.hasAttribute("inert") || (node as HTMLElement & { inert?: boolean }).inert) return;
      node = node.parentElement;
    }
    nativeFocus.call(this, options);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetDom();
});

describe("Dialog", () => {
  it("inerts background siblings and restores their prior accessibility state", () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    opener.setAttribute("aria-hidden", "false");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();

    const { unmount } = render(
      <Dialog title="Calendar" onClose={onClose}>
        <button type="button">First action</button>
      </Dialog>,
      { container: document.body },
    );

    expect(opener.getAttribute("inert")).toBe("");
    expect(opener.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("dialog")).toBeTruthy();

    unmount();
    expect(opener.hasAttribute("inert")).toBe(false);
    expect(opener.getAttribute("aria-hidden")).toBe("false");
  });

  it("keeps background isolated until repeated dialogs have both closed", () => {
    const background = document.createElement("main");
    background.setAttribute("aria-hidden", "false");
    document.body.append(background);
    const first = render(<Dialog title="First" onClose={() => {}} />, { container: document.body });
    const secondHost = document.createElement("div");
    document.body.append(secondHost);
    const second = render(<Dialog title="Second" onClose={() => {}} />, { container: secondHost });

    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(background.hasAttribute("inert")).toBe(true);
    second.unmount();
    expect(background.getAttribute("aria-hidden")).toBe("true");
    first.unmount();
    expect(background.getAttribute("aria-hidden")).toBe("false");
    expect(background.hasAttribute("inert")).toBe(false);
  });

  it("isolates every outside branch when mounted inside nested settings trees", () => {
    const shell = document.createElement("div");
    const settings = document.createElement("section");
    const sidebar = document.createElement("button");
    const account = document.createElement("div");
    const accountContent = document.createElement("div");
    const dialogHost = document.createElement("div");
    const outside = document.createElement("button");
    outside.setAttribute("aria-hidden", "false");

    settings.append(sidebar, account);
    account.append(accountContent, dialogHost);
    shell.append(settings);
    document.body.append(shell, outside);

    const view = render(<Dialog title="Account" onClose={() => {}} />, { container: dialogHost });

    expect(sidebar.hasAttribute("inert")).toBe(true);
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");
    expect(accountContent.hasAttribute("inert")).toBe(true);
    expect(outside.hasAttribute("inert")).toBe(true);
    expect(outside.getAttribute("aria-hidden")).toBe("true");
    expect(settings.hasAttribute("inert")).toBe(false);
    expect(account.hasAttribute("inert")).toBe(false);
    expect(dialogHost.hasAttribute("inert")).toBe(false);

    view.unmount();
    expect(sidebar.hasAttribute("inert")).toBe(false);
    expect(accountContent.hasAttribute("inert")).toBe(false);
    expect(outside.hasAttribute("inert")).toBe(false);
    expect(outside.getAttribute("aria-hidden")).toBe("false");
  });

  it("restores the outer dialog isolation after a nested dialog closes", () => {
    const background = document.createElement("main");
    background.setAttribute("aria-hidden", "false");
    const outerHost = document.createElement("div");
    document.body.append(background, outerHost);
    const outer = render(
      <Dialog title="Outer" onClose={() => {}}><button type="button">Open inner</button></Dialog>,
      { container: outerHost },
    );
    const nestedHost = document.createElement("div");
    const outerBody = outerHost.querySelector<HTMLElement>(".app-dialog__body");
    expect(outerBody).toBeTruthy();
    if (!outerBody) return;
    outerBody.append(nestedHost);

    const innerTrigger = screen.getByRole("button", { name: "Open inner" });
    innerTrigger.focus();
    const inner = render(<Dialog title="Inner" onClose={() => {}} />, { container: nestedHost });
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");

    inner.unmount();
    expect(document.activeElement).toBe(innerTrigger);
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");
    outer.unmount();
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.getAttribute("aria-hidden")).toBe("false");
  });

  it.each(["escape", "backdrop", "close-button"] as const)("releases every outside branch before restoring focus after %s", (reason) => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      return <main>
        <aside><button type="button">Other branch</button></aside>
        <section>
          <div><button type="button" onClick={() => setOpen(true)}>Open dialog</button></div>
          {open && <Dialog title="Test" onClose={() => setOpen(false)} />}
        </section>
      </main>;
    }
    render(<Fixture />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    opener.focus();
    fireEvent.click(opener);
    expect(opener.closest("[inert]")).not.toBeNull();
    const restored = vi.fn(() => {
      // Inspect at the focus event, not merely after all effect cleanups ran.
      expect(document.querySelector("[inert]")).toBeNull();
      expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
    });
    opener.addEventListener("focus", restored);
    if (reason === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "close-button") fireEvent.click(screen.getByRole("button", { name: "Close" }));
    else fireEvent.click(document.querySelector(".app-dialog__scrim") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(restored).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("only dismisses the top stacked dialog and returns focus through the stack", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const outer = render(<Dialog title="Outer" onClose={closeOuter} />);
    const outerClose = screen.getByRole("button", { name: "Close" });
    const inner = render(<Dialog title="Inner" onClose={closeInner} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
    inner.unmount();
    expect(document.activeElement).toBe(outerClose);
    expect(opener.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeOuter).toHaveBeenCalledTimes(1);
    outer.unmount();
    expect(document.activeElement).toBe(opener);
  });

  it.each(["removed", "disabled", "hidden"] as const)("does not attempt to restore a %s trigger", (state) => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<Dialog title="Test" onClose={() => {}} />);
    if (state === "removed") opener.remove();
    else if (state === "disabled") opener.disabled = true;
    else opener.hidden = true;
    const focus = vi.spyOn(opener, "focus");
    view.unmount();
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not restore into a background still isolated by another dialog", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const outer = render(<Dialog title="Outer" onClose={() => {}} />);
    const inner = render(<Dialog title="Inner" onClose={() => {}} />);
    const innerClose = screen.getByRole("button", { name: "Close" });
    const focus = vi.spyOn(opener, "focus");
    outer.unmount();
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(innerClose);
    expect(opener.hasAttribute("inert")).toBe(true);
    inner.unmount();
    expect(opener.hasAttribute("inert")).toBe(false);
  });

  it("updates isolation policy without stealing focus or forgetting the original opener", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<Dialog title="Test" onClose={() => {}} />);
    const close = screen.getByRole("button", { name: "Close" });
    view.rerender(<Dialog title="Test" onClose={() => {}} backgroundInert={false} />);
    expect(opener.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(close);
    view.rerender(<Dialog title="Test" onClose={() => {}} backgroundInert />);
    expect(opener.hasAttribute("inert")).toBe(true);
    view.unmount();
    expect(document.activeElement).toBe(opener);
  });

  it("routes safe backdrop and Escape requests without silently closing", () => {
    const onClose = vi.fn();
    const onRequestClose = vi.fn();
    render(
      <Dialog title="Calendar" onClose={onClose} safeClose onRequestClose={onRequestClose}>
        <button type="button">First action</button>
      </Dialog>,
    );
    const scrim = document.querySelector<HTMLElement>(".app-dialog__scrim");
    expect(scrim).toBeTruthy();
    if (!scrim) return;

    fireEvent.click(scrim);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onRequestClose).toHaveBeenNthCalledWith(1, "backdrop");
    expect(onRequestClose).toHaveBeenNthCalledWith(2, "escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves dismissal-policy aliases and still reports the close-button request", () => {
    const onClose = vi.fn();
    const onDismissRequest = vi.fn();
    render(<Dialog title="Guarded" onClose={onClose} onDismissRequest={onDismissRequest} dismissOnBackdrop={false} dismissOnEscape={false} />);
    fireEvent.click(document.querySelector(".app-dialog__scrim") as HTMLElement);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismissRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismissRequest).toHaveBeenCalledExactlyOnceWith("close-button");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not bypass safeClose when no request handler is supplied", () => {
    const onClose = vi.fn();
    render(<Dialog title="Guarded" onClose={onClose} safeClose />);
    fireEvent.click(document.querySelector(".app-dialog__scrim") as HTMLElement);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Guarded" })).toBeTruthy();
  });

  it("keeps the default backdrop close behavior for existing consumers", () => {
    const onClose = vi.fn();
    render(<Dialog title="Calendar" onClose={onClose} />);
    const scrim = document.querySelector<HTMLElement>(".app-dialog__scrim");
    expect(scrim).toBeTruthy();
    if (scrim) fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps focus and restores the opener after Escape", () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(
      <Dialog title="Calendar" onClose={onClose}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Dialog>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last action" }));
    const buttons = screen.getAllByRole("button");
    const last = buttons[buttons.length - 1];
    last?.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(document.activeElement).toBe(opener);
  });
});
