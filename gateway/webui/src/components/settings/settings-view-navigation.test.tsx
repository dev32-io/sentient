import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileV1 } from "../../services/profile-api.ts";

const mocks = vi.hoisted(() => ({ getMe: vi.fn(), updateMe: vi.fn(), getSoul: vi.fn(), voiceSave: vi.fn(), logout: vi.fn(), createUser: vi.fn(), listUsers: vi.fn(), saveIdentity: vi.fn(), authUser: { userId: "user", displayName: "Ada", isAdmin: true } }));
vi.mock("../../hooks/use-auth.tsx", () => ({ useAuth: () => ({ status: "authenticated", token: "test", user: mocks.authUser, updateUser: (user: typeof mocks.authUser) => { mocks.authUser = user; }, logout: mocks.logout }) }));
vi.mock("../../services/auth-api.ts", () => ({ createAuthApi: () => ({ updateMe: mocks.saveIdentity }) }));
vi.mock("../../services/profile-api.js", () => ({ createProfileApi: () => ({ ...mocks }) }));
vi.mock("./sidebar/sidebar-status.tsx", () => ({ SidebarStatus: () => null }));
vi.mock("../../hooks/use-toast.tsx", () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock("../../services/admin-api.ts", () => ({ createAdminApi: () => ({ createUser: mocks.createUser, listUsers: mocks.listUsers }) }));
vi.mock("../../services/providers-api.ts", () => ({ createProvidersApi: () => ({ listModels: async () => ({ ok: true, value: { models: [{ id: "test-model", provider: "ollama-cloud", contextLength: 32000, supportsTools: true, supportsVision: false }] } }) }) }));
// The voice adapter's sync-only callback is the boundary under test, not audio/network.
vi.mock("../voices/VoicesPanel.tsx", async () => {
  const { useSettingsBusyState } = await import("./navigation-state.ts");
  return { VoicesPanel: ({ onActiveVoiceChanged }: { onActiveVoiceChanged: (id: string) => void }) => {
    const [, setBusy] = useSettingsBusyState();
    return <button onClick={async () => {
      setBusy(true);
      try { await mocks.voiceSave(); onActiveVoiceChanged("new-voice"); }
      finally { setBusy(false); }
    }}>Pick voice</button>;
  } };
});

import { SettingsView, type SettingsNavigationState } from "./settings-view.tsx";

function profile(): ProfileV1 {
  return {
    schemaVersion: 1, userId: "user", model: { provider: "openrouter", id: "model-a" },
    voice: { provider: "local-tts", id: "old-voice" }, audio: { ttsEnabled: true, channel: "voice" },
    memory: { spark: true, dreaming: false }, persona: { template: "default", overrides: "" },
    tools: {}, compression: { threshold: 0.8 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authUser = { userId: "user", displayName: "Ada", isAdmin: true };
  mocks.voiceSave.mockResolvedValue(undefined);
  mocks.listUsers.mockResolvedValue({ ok: true, value: { users: [] } });
  mocks.getMe.mockResolvedValue({ ok: true, value: profile() });
  mocks.updateMe.mockResolvedValue({ ok: true, value: profile() });
  mocks.getSoul.mockResolvedValue({ ok: true, value: { content: "", lastModified: null } });
});
afterEach(cleanup);

describe("Settings navigation contract", () => {
  it("preserves a pending profile and an immediately saved voice across panes, and holds busy through readback", async () => {
    const report = vi.fn<(state: SettingsNavigationState) => void>();
    const liveAudio = vi.fn();
    const view = render(<SettingsView initialTab="audio" onNavigationStateChange={report} onAudioApplied={liveAudio} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Speak responses" }));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: false }));
    fireEvent.click(screen.getByRole("button", { name: "Voice" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Pick voice" })); });
    fireEvent.click(screen.getByRole("button", { name: /^Audio/ }));
    expect(screen.getByRole("switch", { name: "Speak responses" }).getAttribute("aria-checked")).toBe("false");

    const readback = deferred<{ ok: true; value: ProfileV1 }>();
    mocks.getMe.mockReturnValueOnce(readback.promise);
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(mocks.updateMe).toHaveBeenCalledTimes(1));
    const saved = mocks.updateMe.mock.calls[0]![1] as ProfileV1;
    expect(saved.voice.id).toBe("new-voice");
    expect(saved.audio.ttsEnabled).toBe(false);
    expect(saved.model).toEqual(profile().model);
    expect(liveAudio).toHaveBeenCalledWith({ ttsEnabled: false, channel: "voice" });
    expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: true });

    // A non-Apply pane must not unmount the in-flight owner or enable Discard.
    fireEvent.click(screen.getByRole("button", { name: "Get the app" }));
    expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true);
    expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: true });
    await act(async () => readback.resolve({ ok: true, value: saved }));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: false }));
    view.unmount();
    expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: false });
  });

  it("retains ownership of immediate saves after internal pane changes and prevents a competing profile Apply", async () => {
    const report = vi.fn();
    const saving = deferred<void>();
    mocks.voiceSave.mockReturnValue(saving.promise);
    render(<SettingsView initialTab="audio" onNavigationStateChange={report} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Speak responses" }));
    fireEvent.click(screen.getByRole("button", { name: "Voice" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick voice" }));
    fireEvent.click(screen.getByRole("button", { name: /^Audio/ }));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: true }));
    expect((screen.getByRole("button", { name: "Apply changes" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => saving.resolve());
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: false }));
    expect((screen.getByRole("button", { name: "Apply changes" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("retains the Account name and shell dirty registration across panes, then clears it after saving", async () => {
    const report = vi.fn();
    const save = deferred<unknown>();
    mocks.saveIdentity.mockReturnValue(save.promise);
    render(<SettingsView initialTab="account" onNavigationStateChange={report} />);
    fireEvent.input(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Ada revised" } });
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: false }));
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    await screen.findByRole("switch", { name: "Speak responses" });
    expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: false });
    const accountTab = screen.getByRole("button", { name: "Account" });
    fireEvent.click(accountTab);
    expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe("Ada revised");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.saveIdentity).toHaveBeenCalledWith("test", { displayName: "Ada revised" });
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: true }));
    await act(async () => save.resolve({ ok: true, value: { user: { ...mocks.authUser, displayName: "Ada revised" } } }));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: false }));
    expect(screen.getByRole("button", { name: "Account" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe("Ada revised");
  });

  it("resets a retained name when the server identity changes or settings is discarded by unmount", async () => {
    const report = vi.fn();
    const view = render(<SettingsView initialTab="account" onNavigationStateChange={report} />);
    fireEvent.input(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    mocks.authUser = { ...mocks.authUser, displayName: "Server name" };
    view.rerender(<SettingsView onNavigationStateChange={report} />);
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: false }));
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe("Server name");
    fireEvent.input(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Another draft" } });
    mocks.authUser = { ...mocks.authUser, userId: "other-user" };
    view.rerender(<SettingsView onNavigationStateChange={report} />);
    expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe("Server name");
    fireEvent.input(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Discard this" } });
    view.unmount();
    expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: false });
    render(<SettingsView initialTab="account" onNavigationStateChange={report} />);
    expect((screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement).value).toBe("Server name");
    expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: false });
  });

  it("delegates account logout with dirty guard state without signing out or discarding", async () => {
    const report = vi.fn();
    const requestLogout = vi.fn();
    render(<SettingsView initialTab="audio" onNavigationStateChange={report} onRequestLogout={requestLogout} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Speak responses" }));
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: false }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(requestLogout).toHaveBeenCalledTimes(1);
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: false });
    fireEvent.click(screen.getByRole("button", { name: /^Audio/ }));
    expect(screen.getByRole("switch", { name: "Speak responses" }).getAttribute("aria-checked")).toBe("false");
  });

  it.each([false, true])("reports pending wizard API ownership (internal departure: %s)", async (leavePane) => {
    const report = vi.fn();
    const submission = deferred<unknown>();
    mocks.createUser.mockReturnValue(submission.promise);
    render(<SettingsView initialTab="members" onNavigationStateChange={report} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add user" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Display name" }), { target: { value: "Test member" } });
    fireEvent.input(screen.getByLabelText("PIN"), { target: { value: "1234" } });
    fireEvent.input(screen.getByLabelText("Confirm PIN"), { target: { value: "1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: /test-model/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(mocks.createUser).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: true }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Add user" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    // Exercise retained ownership even if a caller changes panes behind the modal.
    if (leavePane) fireEvent.click(screen.getByRole("button", { name: "Get the app", hidden: true }));
    expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: true });
    await act(async () => submission.resolve(leavePane
      ? { ok: false, error: { status: 503, code: "unavailable" } }
      : { ok: true, value: { user: { userId: "new-user", displayName: "Test member", isAdmin: false, avatarTint: "", slotKey: "a", createdAt: "now" } } }));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: false }));
    if (!leavePane) expect(screen.getByText("Test member")).not.toBeNull();
  });

  it("reports failed Apply as dirty but no longer busy and clears the parent on unmount", async () => {
    const report = vi.fn();
    mocks.updateMe.mockResolvedValue({ ok: false, error: { code: "unavailable" } });
    const view = render(<SettingsView initialTab="audio" onNavigationStateChange={report} />);
    fireEvent.click(await screen.findByRole("switch", { name: "Speak responses" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await screen.findByRole("button", { name: "Retry" });
    await waitFor(() => expect(report).toHaveBeenLastCalledWith({ dirty: true, busy: false }));
    view.unmount();
    expect(report).toHaveBeenLastCalledWith({ dirty: false, busy: false });
  });
});
