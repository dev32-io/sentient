import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

vi.mock("../common/sentient-mark.tsx", () => ({ SentientMark: () => <span aria-hidden="true" /> }));

import { Topbar } from "./topbar.tsx";

function renderTopbar(isAdmin = false) {
  const onSettingsClick = vi.fn();
  const onNotificationsClick = vi.fn();
  const result = render(
    <Topbar
      householdName="My Home"
      routeLabel="Conversation"
      activeRoute="chat"
      onChatClick={vi.fn()}
      onCalendarClick={vi.fn()}
      onSettingsClick={onSettingsClick}
      onMenuClick={vi.fn()}
      onNotificationsClick={onNotificationsClick}
      user={{ userId: "u-1", displayName: "Sam", isAdmin, avatarTint: "sage" }}
      onLogout={vi.fn()}
      onOpenAccount={vi.fn()}
    />,
  );
  return { onSettingsClick, onNotificationsClick, container: result.container };
}

describe("Topbar", () => {
  it("opens the card inbox without fabricated telemetry", () => {
    const { container, onNotificationsClick } = renderTopbar();
    const messages = screen.getByRole("button", { name: "Messages" });
    expect((messages as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(messages);
    expect(onNotificationsClick).toHaveBeenCalledOnce();
    expect(container.textContent).not.toMatch(/devices? online|14 devices/i);
  });

  it("keeps household navigation available to a non-admin without claiming admin authority", () => {
    const { onSettingsClick } = renderTopbar(false);
    fireEvent.click(screen.getByRole("button", { name: "Household" }));
    expect(onSettingsClick).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Profile: Sam" }));
    expect(screen.getByRole("menuitem", { name: "My account" })).toBeTruthy();
    expect(screen.queryByText(/admin/i)).toBeNull();
  });
});
