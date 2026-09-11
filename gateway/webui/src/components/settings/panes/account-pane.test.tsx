import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

const changePin = vi.hoisted(() => vi.fn());
const logout = vi.hoisted(() => vi.fn());
vi.mock("../../../hooks/use-auth.tsx", () => ({ useAuth: () => ({ status: "authenticated", token: "token", user: { displayName: "Ada" }, updateUser: vi.fn(), logout }) }));
vi.mock("../../../hooks/use-toast.tsx", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("../../../services/auth-api.ts", () => ({ createAuthApi: () => ({ updateMe: vi.fn(), changePin }) }));

import { AccountPane } from "./account-pane.tsx";

describe("AccountPane Pin validation", () => {
  it("requires two complete four-digit Pins and reports a rejected current Pin", async () => {
    changePin.mockResolvedValue({ ok: false, error: { status: 401, code: "invalid-pin" } });
    render(<AccountPane />);
    fireEvent.click(screen.getByRole("button", { name: "Change Pin" }));
    const submit = screen.getByRole("button", { name: "Update Pin" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    for (const label of ["Current Pin", "New Pin"]) {
      for (let digit = 1; digit <= 4; digit += 1) {
        fireEvent.input(screen.getByLabelText(`${label} digit ${digit}`), { target: { value: String(digit) } });
      }
    }
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(await screen.findByText("Current Pin is wrong")).not.toBeNull();
    expect(changePin).toHaveBeenCalledWith("token", { currentPin: "1234", newPin: "1234" });
  });
  it("uses the existing auth logout when rendered without a shell callback", () => {
    logout.mockClear();
    render(<AccountPane />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

});
