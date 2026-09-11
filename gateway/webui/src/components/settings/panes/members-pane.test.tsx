import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

const listUsers = vi.hoisted(() => vi.fn());
vi.mock("../../../hooks/use-auth.tsx", () => ({ useAuth: () => ({ status: "authenticated", token: "token", user: { userId: "self", displayName: "Ada", isAdmin: true } }) }));
vi.mock("../../../hooks/use-toast.tsx", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("../../../services/admin-api.ts", () => ({ createAdminApi: () => ({ listUsers, setIsAdmin: vi.fn(), deleteUser: vi.fn() }) }));
vi.mock("../../account-wizard/AccountWizard.tsx", () => ({ AccountWizard: () => <div>Add member form</div> }));

import { MembersPane } from "./members-pane.tsx";

describe("MembersPane authorization recovery", () => {
  it("replaces the roster with an admin-required state on 403 and can retry", async () => {
    listUsers
      .mockResolvedValueOnce({ ok: false, error: { status: 403, code: "forbidden" } })
      .mockResolvedValueOnce({ ok: true, value: { users: [{ userId: "self", displayName: "Ada", isAdmin: true, avatarTint: "", slotKey: "a", createdAt: "now" }] } });
    render(<MembersPane />);
    expect(await screen.findByText("Admin access required")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1 active · 2 slots free")).not.toBeNull();
  });
});
