import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORAGE_KEY } from "../constants.ts";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const user = { userId: "u-1", displayName: "Sam", avatarTint: "sage", isAdmin: false };
const success = { ok: true as const, value: { token: "new-token", user } };
const failure = { ok: false as const, error: { status: 401, code: "invalid-credentials" } };

function CaptureAuth({ capture }: { capture: (auth: ReturnType<typeof useAuth>) => void }) {
  const auth = useAuth();
  capture(auth);
  return <output aria-label="auth state">{auth.status}</output>;
}

describe("AuthProvider attempt ownership", () => {
  for (const oldResult of [success, failure]) {
    it(`supersedes an old ${oldResult.ok ? "success" : "failure"} even when callers omit signals`, async () => {
      const old = deferred<typeof success | typeof failure>();
      const api = { login: vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue(success) } as unknown as AuthApi;
      let auth!: ReturnType<typeof useAuth>;
      render(<AuthProvider api={api}><CaptureAuth capture={(value) => { auth = value; }} /></AuthProvider>);
      await waitFor(() => expect(auth.status).toBe("anonymous"));
      const oldLogin = auth.login({ userId: "u-1", pin: "1234" });
      await waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));
      await auth.login({ userId: "u-2", pin: "1234" });
      old.resolve(oldResult);
      expect(await oldLogin).toEqual({ ok: false, error: { status: 0, code: "login-cancelled" } });
      await waitFor(() => expect(auth.status).toBe("authenticated"));
      expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBe(JSON.stringify({ token: "new-token" }));
    });
  }

  it("does not persist when an obsolete beforeCommit resolves normally", async () => {
    const feedback = deferred<void>();
    const beforeCommit = vi.fn(() => feedback.promise);
    const api = { login: vi.fn().mockResolvedValueOnce({ ...success, value: { ...success.value, token: "old-token" } }).mockResolvedValue(success) } as unknown as AuthApi;
    let auth!: ReturnType<typeof useAuth>;
    render(<AuthProvider api={api}><CaptureAuth capture={(value) => { auth = value; }} /></AuthProvider>);
    await waitFor(() => expect(auth.status).toBe("anonymous"));
    const oldLogin = auth.login({ userId: "u-1", pin: "1234" }, { beforeCommit });
    await waitFor(() => expect(beforeCommit).toHaveBeenCalledOnce());
    await auth.login({ userId: "u-2", pin: "1234" });
    feedback.resolve();
    expect((await oldLogin).ok).toBe(false);
    await waitFor(() => expect(auth.status).toBe("authenticated"));
    for (const store of [sessionStorage, localStorage]) expect(store.getItem(AUTH_STORAGE_KEY)).toBe(JSON.stringify({ token: "new-token" }));
  });

  it("restores remembered auth without running a login presentation", async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: "remembered" }));
    const api = { me: vi.fn().mockResolvedValue(success), login: vi.fn() } as unknown as AuthApi;
    let auth!: ReturnType<typeof useAuth>;
    render(<AuthProvider api={api}><CaptureAuth capture={(value) => { auth = value; }} /></AuthProvider>);
    await waitFor(() => expect(auth.status).toBe("authenticated"));
    expect(api.me).toHaveBeenCalledWith("remembered");
    expect(api.login).not.toHaveBeenCalled();
  });
});
