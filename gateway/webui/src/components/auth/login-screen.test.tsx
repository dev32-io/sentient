import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthApi } from "../../services/auth-api.ts";
import { AUTH_STORAGE_KEY, AUTH_TIMEOUT_MS } from "../../constants.ts";
import { AuthProvider, useAuth } from "../../hooks/use-auth.tsx";
import { LoginScreen } from "./login-screen.tsx";

// Rendering belongs to browser review; retain the real identity component with an inert canvas adapter.
vi.mock("@rive-app/canvas", () => ({ Rive: class {
  stateMachineInputs() { return []; }
  resizeDrawingSurfaceToCanvas() {}
  cleanup() {}
} }));

const user = { userId: "u-1", displayName: "Sam", avatarTint: "sage", isAdmin: false };
const success = { ok: true as const, value: { token: "test-token", user } };
const wrong = { ok: false as const, error: { status: 401, code: "invalid-credentials" } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const advance = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const status = () => screen.getByLabelText("auth state").textContent;
const keypadState = () => screen.getByLabelText("PIN keypad").closest(".snt-pin-keypad")?.getAttribute("data-state");
function expectStored(token: string | null) {
  for (const store of [sessionStorage, localStorage]) {
    expect(store.getItem(AUTH_STORAGE_KEY)).toBe(token ? JSON.stringify({ token }) : null);
  }
}
function Harness({ api }: { api: AuthApi }) {
  const auth = useAuth();
  const [visible, setVisible] = useState(true);
  return <>
    <output aria-label="auth state">{auth.status}</output>
    <button type="button" onClick={() => setVisible(false)}>Unmount login</button>
    {visible && auth.status !== "authenticated" && <LoginScreen api={api} auth={auth} notice="Your session expired. Sign in again." />}
  </>;
}
async function mount(login = vi.fn().mockResolvedValue(success), people = [user]) {
  const api = { login, listUsers: vi.fn().mockResolvedValue({ ok: true, value: people }) } as unknown as AuthApi;
  const view = render(<AuthProvider api={api}><Harness api={api} /></AuthProvider>);
  await advance();
  return { ...view, api, login };
}
function selectAndSubmit() {
  fireEvent.click(screen.getByRole("button", { name: "Continue as Sam" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "PIN digit 1" }));
  for (const key of "1234") fireEvent.keyDown(document.activeElement!, { key });
}
beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });

describe("Homecoming login boundary", () => {
  it.each([false, true])("holds fast success for 700ms + 250ms with no extra dwell (reduced motion: %s)", async (reducedMotion) => {
    vi.stubGlobal("matchMedia", () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }));
    await mount();
    selectAndSubmit();
    await advance(699);
    expect(keypadState()).toBe("checking");
    expectStored(null);
    await advance(1);
    expect(keypadState()).toBe("success");
    await advance(249);
    expect(status()).toBe("authenticating");
    expectStored(null);
    await advance(1);
    expect(status()).toBe("authenticated");
    expectStored("test-token");
    // The normal authenticated handoff unmounted LoginScreen and aborted its local signal.
    await advance(1000);
    expect(status()).toBe("authenticated");
    expectStored("test-token");
  });

  it("does not add another checking delay after a slow successful response", async () => {
    const response = deferred<typeof success>();
    await mount(vi.fn(() => response.promise));
    selectAndSubmit();
    await advance(1200);
    expect(keypadState()).toBe("checking");
    response.resolve(success);
    await advance();
    expect(keypadState()).toBe("success");
    await advance(249);
    expectStored(null);
    await advance(1);
    expect(status()).toBe("authenticated");
  });

  it("preserves wrong-pin feedback and allows a keyboard retry", async () => {
    const login = vi.fn().mockResolvedValueOnce(wrong).mockResolvedValue(success);
    await mount(login);
    selectAndSubmit();
    await advance(699);
    expect(keypadState()).toBe("checking");
    await advance(1);
    expect(screen.getByRole("alert").textContent).toContain("Wrong PIN");
    expect(keypadState()).toBe("error");
    const first = screen.getByRole("button", { name: "PIN digit 1" });
    expect((first as HTMLButtonElement).disabled).toBe(true);
    await advance(250);
    first.focus();
    for (const key of "1234") fireEvent.keyDown(first, { key });
    await advance(950);
    expect(login).toHaveBeenCalledTimes(2);
    expect(status()).toBe("authenticated");
  });

  for (const phase of ["network", "accepted"] as const) {
    for (const action of ["Back", "unmount", "provider unmount"] as const) {
      it(`cancels ${phase} on ${action} without persisting late success`, async () => {
        const response = deferred<typeof success>();
        const view = await mount(vi.fn(() => response.promise));
        selectAndSubmit();
        if (phase === "accepted") response.resolve(success);
        await advance(700);
        if (phase === "accepted") expect(keypadState()).toBe("success");
        if (action === "Back") fireEvent.keyDown(window, { key: "Escape" });
        else if (action === "unmount") fireEvent.click(screen.getByRole("button", { name: "Unmount login" }));
        else view.unmount();
        await advance();
        if (action === "Back") expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue as Sam" }));
        response.resolve(success);
        await advance(2000);
        expectStored(null);
        if (action !== "provider unmount") expect(status()).toBe("anonymous");
      });
    }
  }

  for (const oldResult of [success, wrong]) {
    it(`ignores old ${oldResult.ok ? "success" : "failure"} after a newer login commits`, async () => {
      const response = deferred<typeof success | typeof wrong>();
      const login = vi.fn().mockImplementationOnce(() => response.promise).mockResolvedValue(success);
      await mount(login);
      selectAndSubmit();
      await advance();
      fireEvent.click(screen.getByRole("button", { name: "← Back to profiles" }));
      selectAndSubmit();
      await advance(950);
      expect(status()).toBe("authenticated");
      response.resolve(oldResult);
      await advance(1000);
      expectStored("test-token");
      expect(status()).toBe("authenticated");
    });
  }

  it("times out a stalled request and lets the user retry without accepting the late result", async () => {
    const response = deferred<typeof success>();
    const login = vi.fn().mockImplementationOnce(() => response.promise).mockResolvedValue(success);
    await mount(login);
    selectAndSubmit();
    await advance(AUTH_TIMEOUT_MS);
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong");
    response.resolve(success);
    await advance(250);
    expectStored(null);
    for (const key of "1234") fireEvent.click(screen.getByRole("button", { name: `PIN digit ${key}` }));
    await advance(950);
    expect(status()).toBe("authenticated");
  });
});

describe("Homecoming recovery and navigation", () => {
  it("shows search only above six profiles, filters/counts/clears and keeps profile focus on Back", async () => {
    const people = Array.from({ length: 7 }, (_, index) => ({ ...user, userId: `u-${index}`, displayName: index === 0 ? "Sam" : `Person ${index}` }));
    await mount(undefined, people);
    const search = screen.getByRole("searchbox", { name: "Find your name" });
    fireEvent.input(search, { target: { value: "Nobody" } });
    expect(screen.getByText("0 of 7")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue as Sam" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear name search" }));
    expect(document.activeElement).toBe(search);
    fireEvent.input(search, { target: { value: " sam " } });
    expect(screen.getByText("1 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue as Sam" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue as Sam" }));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(" sam ");
  });

  it("opens truthful help, closes with Escape and restores focus without leaving the PIN stage", async () => {
    await mount();
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue as Sam" }));
    const help = screen.getByRole("button", { name: "Need help signing in?" });
    help.focus();
    fireEvent.click(help);
    await advance();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await advance();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(help);
    expect(screen.getByRole("heading", { name: "Enter PIN for Sam" })).toBeTruthy();
  });

  it("retains expiry notice during loading/error/retry and handles an empty household", async () => {
    const response = deferred<Awaited<ReturnType<AuthApi["listUsers"]>>>();
    const api = { listUsers: vi.fn().mockImplementationOnce(() => response.promise).mockResolvedValue({ ok: true, value: [] }) } as unknown as AuthApi;
    render(<LoginScreen api={api} auth={{ login: vi.fn() }} notice="Session expired" />);
    expect(screen.getByText("Session expired")).toBeTruthy();
    await advance(AUTH_TIMEOUT_MS);
    expect(screen.getByText("Could not load profiles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await advance();
    expect(screen.getByText("No profiles found")).toBeTruthy();
    response.resolve({ ok: true, value: [user] });
    await advance();
    expect(screen.getByText("No profiles found")).toBeTruthy();
    expect(screen.getByText("Session expired")).toBeTruthy();
  });
});
