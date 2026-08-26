import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthApi } from "../services/auth-api.ts";
import { AuthProvider, useAuth } from "./use-auth.tsx";

function AuthStatusProbe({ beforeCommit }: { beforeCommit: () => Promise<void> }) {
  const auth = useAuth();
  return (
    <>
      <output aria-label="auth state">{auth.status}</output>
      <button type="button" onClick={() => void auth.login({ userId: "u-1", pin: "1234" }, { beforeCommit })}>Log in</button>
    </>
  );
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe("AuthProvider login presentation boundary", () => {
  it("does not commit authenticated state until client feedback resolves", async () => {
    let resolveBeforeCommit: (() => void) | undefined;
    const presentation = new Promise<void>((resolve) => {
      resolveBeforeCommit = resolve;
    });
    const beforeCommit = vi.fn(() => presentation);
    const api = {
      login: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          token: "token",
          user: { userId: "u-1", displayName: "Sam", role: "adult", isAdmin: false, avatarTint: "sage" },
        },
      }),
    } as unknown as AuthApi;

    render(
      <AuthProvider api={api}>
        <AuthStatusProbe beforeCommit={beforeCommit} />
      </AuthProvider>,
    );

    const status = () => screen.getByLabelText("auth state").textContent;
    await waitFor(() => expect(status()).toBe("anonymous"));
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(beforeCommit).toHaveBeenCalledTimes(1));
    expect(status()).toBe("authenticating");

    resolveBeforeCommit?.();
    await waitFor(() => expect(status()).toBe("authenticated"));
  });
});
