import { signal } from "@preact/signals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useEffect, useState } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORAGE_KEY } from "./constants.ts";
import { ROUTE_STORAGE_KEY } from "./components/shell/route-state.ts";
import type { AuthApi } from "./services/auth-api.ts";
import { App } from "./app.tsx";

const observed = vi.hoisted(() => ({ startClient: vi.fn(), createDraft: vi.fn(), dispose: vi.fn(), client: null as unknown }));
vi.mock("./hooks/use-install-state.ts", () => ({ useInstallState: () => ({ state: { bootstrap_complete: true }, loading: false, error: null }) }));
vi.mock("./hooks/use-voice-client.ts", () => ({ useVoiceClient: () => { observed.startClient(); return observed.client; } }));
vi.mock("./hooks/use-sessions.ts", () => ({ createUseSessions: () => ({ dispose: observed.dispose }) }));
vi.mock("./components/common/sentient-mark.tsx", () => ({ SentientMark: () => <span aria-hidden="true">Mark</span> }));
vi.mock("./components/chat/chat-view.tsx", () => ({ ChatView: () => <h1>Chat fixture</h1> }));
vi.mock("./components/calendar/calendar-view.tsx", () => ({ CalendarView: () => <h1>Calendar fixture</h1> }));
vi.mock("./components/dock/composer.tsx", () => ({ ChatComposer: () => null }));
vi.mock("./components/settings/settings-view.tsx", () => ({
  SettingsView: ({ initialTab, onNavigationStateChange }: { initialTab: string; onNavigationStateChange: (s: { dirty: boolean; busy: boolean }) => void }) => {
    const [dirty, setDirty] = useState(false);
    useEffect(() => onNavigationStateChange({ dirty, busy: false }), [dirty, onNavigationStateChange]);
    useEffect(() => () => onNavigationStateChange({ dirty: false, busy: false }), [onNavigationStateChange]);
    return <section><h1>Settings fixture: {initialTab}</h1><button type="button" onClick={() => setDirty(true)}>Make unsaved edit</button>{dirty && <p>Draft retained</p>}</section>;
  },
}));
// Model the drawer's public guard contract. Its actual switching, failure and
// focus behavior is covered by drawer.test.tsx and use-sessions.test.ts.
vi.mock("./components/sessions/drawer.tsx", () => ({
  Drawer: ({ open, onClose, onBeforeSessionChange, onSessionSelected }: { open: boolean; onClose: () => void; onBeforeSessionChange: () => Promise<boolean>; onSessionSelected: () => void }) => open ?
    <button type="button" onClick={async () => { if (await onBeforeSessionChange()) { observed.createDraft(); onSessionSelected(); onClose(); } }}>Create draft fixture</button> : null,
}));
vi.mock("./components/auth/login-screen.tsx", () => ({
  LoginScreen: ({ auth }: { auth: { login: AuthApi["login"] } }) => <button type="button" onClick={() => void auth.login({ userId: "synthetic", pin: "1234" })}>Verify fixture PIN</button>,
}));

const user = { userId: "synthetic", displayName: "Synthetic User", avatarTint: "sage", isAdmin: false };
const authenticated = { ok: true as const, value: { token: "fixture-token", user } };
function api(): AuthApi {
  return {
    listUsers: async () => ({ ok: true, value: [user] }),
    me: async () => authenticated,
    login: async () => authenticated,
    setup: async () => authenticated,
    logout: async () => ({ ok: true, value: { ok: true } }),
    updateMe: async () => authenticated,
    changePin: async () => ({ ok: true, value: { ok: true } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  observed.client = {
    sessionsConnector: {}, cycleStatus: signal("idle"), tasks: signal([]), messages: signal([]), currentTurnId: signal(null),
    sdkStatus: signal("ready"), connectionLost: signal(false), authExpired: signal(false), commandRejection: signal(null),
    transcript: signal(""), voiceMode: signal("off"), prefs: signal({ ttsEnabled: false }), permissionRequest: signal(null),
    patchPreferences: vi.fn(), seedPreferences: vi.fn(),
  };
  // Profile seeding is incidental to shell navigation. No real I/O in this test.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ audio: { ttsEnabled: false, channel: "text" } }), { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mountStored(route = "settings") {
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: "fixture-token" }));
  sessionStorage.setItem(ROUTE_STORAGE_KEY, route);
  return render(<App api={api()} />);
}

describe("shell navigation protects settings and conversation identity", () => {
  it("brand click/keyboard activation returns to existing chat only after draft confirmation", async () => {
    mountStored();
    await screen.findByText("Settings fixture: memory");
    fireEvent.click(screen.getByText("Make unsaved edit"));
    const brand = screen.getByRole("button", { name: "Sentient — go to chat" });
    brand.focus();
    fireEvent.click(brand);
    fireEvent.click(await screen.findByRole("button", { name: "Stay", exact: true }));
    expect(screen.getByText("Draft retained")).toBeTruthy();
    expect(sessionStorage.getItem(ROUTE_STORAGE_KEY)).toBe("settings");
    fireEvent.click(brand);
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await screen.findByText("Chat fixture");
    expect(sessionStorage.getItem(ROUTE_STORAGE_KEY)).toBe("chat");
    expect(observed.createDraft).not.toHaveBeenCalled();
  });

  it("guards settings remounts and calendar navigation without dropping a cancelled draft", async () => {
    mountStored();
    await screen.findByText("Settings fixture: memory");
    fireEvent.click(screen.getByText("Make unsaved edit"));
    fireEvent.click(screen.getByRole("button", { name: "Household", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Stay", exact: true }));
    expect(screen.getByText("Draft retained")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Calendar", exact: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await screen.findByText("Calendar fixture");
    expect(sessionStorage.getItem(ROUTE_STORAGE_KEY)).toBe("calendar");
  });

  it("does not create a draft before permission; successful creation reveals chat", async () => {
    mountStored();
    await screen.findByText("Settings fixture: memory");
    fireEvent.click(screen.getByText("Make unsaved edit"));
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
    fireEvent.click(screen.getByText("Create draft fixture"));
    await screen.findByRole("dialog");
    expect(observed.createDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stay", exact: true }));
    expect(observed.createDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Create draft fixture"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
    await screen.findByText("Chat fixture");
    expect(observed.createDraft).toHaveBeenCalledTimes(1);
  });

  it("fresh verification enters chat without initializing authenticated effects early; hydrate keeps route", async () => {
    sessionStorage.setItem(ROUTE_STORAGE_KEY, "calendar");
    const view = render(<App api={api()} />);
    const verify = await screen.findByText("Verify fixture PIN");
    expect(observed.startClient).not.toHaveBeenCalled();
    fireEvent.click(verify);
    await screen.findByText("Chat fixture");
    expect(view.container.querySelector("[data-login-arrival]")).not.toBeNull();
    expect(observed.startClient).toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(observed.dispose).toHaveBeenCalled());
    const restored = mountStored("calendar");
    await screen.findByText("Calendar fixture");
    expect(restored.container.querySelector("[data-login-arrival]")).toBeNull();
  });
});
