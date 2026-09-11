import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useEffect } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsDeparture } from "./settings-departure.tsx";

function Harness({ dirty = true, busy = false, action }: { dirty?: boolean; busy?: boolean; action: () => void }) {
  const departure = useSettingsDeparture();
  useEffect(() => departure.onStateChange({ dirty, busy }), [dirty, busy, departure.onStateChange]);
  return <>
    <button type="button" onClick={async () => { if (await departure.request()) action(); }}>Navigate</button>
    {departure.dialog}
  </>;
}

afterEach(cleanup);

describe("settings departure authority", () => {
  it("keeps navigation/session effects untouched until explicit discard", async () => {
    const action = vi.fn();
    render(<Harness action={action} />);
    fireEvent.click(screen.getByText("Navigate"));
    await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stay", exact: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Navigate"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it("treats Escape as Stay and restores the navigation trigger", async () => {
    const action = vi.fn();
    render(<Harness action={action} />);
    const trigger = screen.getByText("Navigate");
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay", exact: true })));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(action).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not discard an active save; after completion departure remains an explicit choice", async () => {
    const action = vi.fn();
    const view = render(<Harness busy action={action} />);
    fireEvent.click(screen.getByText("Navigate"));
    await screen.findByRole("dialog", { name: "Saving your changes" });
    expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();
    expect(action).not.toHaveBeenCalled();
    view.rerender(<Harness dirty={false} busy={false} action={action} />);
    const leave = await screen.findByRole("button", { name: "Leave settings" });
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(leave);
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it("never lets a second request replace the first choice or run effects after unmount", async () => {
    const action = vi.fn();
    const view = render(<Harness action={action} />);
    const trigger = screen.getByText("Navigate");
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    view.unmount();
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
  });

  it("allows clean settings without a confirmation", async () => {
    const action = vi.fn();
    render(<Harness dirty={false} action={action} />);
    fireEvent.click(screen.getByText("Navigate"));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
