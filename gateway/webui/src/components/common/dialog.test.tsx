import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./dialog.tsx";

function resetDom(): void {
  document.body.innerHTML = "";
}

afterEach(resetDom);

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
      <Dialog title="Outer" onClose={() => {}}><div>Outer content</div></Dialog>,
      { container: outerHost },
    );
    const nestedHost = document.createElement("div");
    const outerBody = outerHost.querySelector<HTMLElement>(".app-dialog__body");
    expect(outerBody).toBeTruthy();
    if (!outerBody) return;
    outerBody.append(nestedHost);

    const inner = render(<Dialog title="Inner" onClose={() => {}} />, { container: nestedHost });
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");

    inner.unmount();
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");
    outer.unmount();
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.getAttribute("aria-hidden")).toBe("false");
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
