import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { AuthApi } from "../../services/auth-api.ts";
import { LoginScreen } from "./login-screen.tsx";

describe("LoginScreen", () => {
  it("keeps the selected profile visible and reports a wrong PIN", async () => {
    const api = {
      listUsers: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u-1", displayName: "Sam", avatarTint: "sage" }] }),
    } as unknown as AuthApi;
    const login = vi.fn().mockResolvedValue({ ok: false, error: { status: 401, code: "invalid-credentials" } });
    render(<LoginScreen api={api} auth={{ login }} />);

    const profile = await screen.findByRole("button", { name: "Continue as Sam" });
    expect(profile.classList.contains("snt-media-card")).toBe(true);
    expect(profile.querySelector(".snt-media-card__visual .snt-avatar")).toBeTruthy();
    fireEvent.click(profile);
    expect(screen.getByRole("button", { name: "Delete last digit" }).classList.contains("snt-button--destructive")).toBe(false);
    for (const digit of ["1", "2", "3", "4"]) fireEvent.click(screen.getByRole("button", { name: `PIN digit ${digit}` }));

    await waitFor(() => expect(login).toHaveBeenCalledWith(
      { userId: "u-1", pin: "1234" },
      expect.objectContaining({ beforeCommit: expect.any(Function) }),
    ));
    expect((await screen.findByRole("alert")).textContent).toContain("Wrong PIN");
    const keypad = screen.getByLabelText("PIN keypad").closest(".snt-pin-keypad");
    expect(keypad?.getAttribute("data-state")).toBe("error");
    expect(keypad?.querySelectorAll('[data-filled="true"]')).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Enter PIN for Sam" })).toBeTruthy();
  });

  it("keeps successful PIN feedback visible through the client transition", async () => {
    vi.useFakeTimers();
    try {
      const api = {
        listUsers: vi.fn().mockResolvedValue({ ok: true, value: [{ userId: "u-1", displayName: "Sam", avatarTint: "sage" }] }),
      } as unknown as AuthApi;
      const login = vi.fn().mockImplementation(async (_input, options) => {
        await options?.beforeCommit?.();
        return { ok: true as const, value: { token: "token" } };
      });
      render(<LoginScreen api={api} auth={{ login }} />);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole("button", { name: "Continue as Sam" }));
      for (const digit of ["1", "2", "3", "4"]) fireEvent.click(screen.getByRole("button", { name: `PIN digit ${digit}` }));

      const keypad = screen.getByLabelText("PIN keypad").closest(".snt-pin-keypad");
      expect(keypad?.getAttribute("data-state")).toBe("checking");
      await act(async () => { await vi.advanceTimersByTimeAsync(699); });
      expect(keypad?.getAttribute("data-state")).toBe("checking");

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(keypad?.getAttribute("data-state")).toBe("success");
      expect(screen.getByText("Pin accepted.")).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(249); });
      expect(keypad?.getAttribute("data-state")).toBe("success");
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(login).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
