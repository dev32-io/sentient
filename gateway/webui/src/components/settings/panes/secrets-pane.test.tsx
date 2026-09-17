import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSecretsStatus: vi.fn(),
  setLlmProviderKey: vi.fn(),
  setActiveLlmProvider: vi.fn(),
  setApnsCredentials: vi.fn(),
  applyApnsCredentials: vi.fn(),
}));
vi.mock("../../../hooks/use-auth.tsx", () => ({ useAuth: () => ({ status: "authenticated", token: "token", user: { isAdmin: true } }) }));
vi.mock("../../../services/admin-api.ts", () => ({ createAdminApi: () => api }));

import { SecretsPane } from "./secrets-pane.tsx";

function status(push = { has_key: true, has_key_id: true, has_team_id: true }) {
  return {
    llm: {
      active: "openrouter",
      openrouter: { has_key: true, has_base_url: false, value: "must-not-render" },
      ollama_cloud: { has_key: false, has_base_url: false },
      custom: { has_key: true, has_base_url: true },
    },
    home_assistant: { observe_token: { has_token: false }, mcp_server_token: { has_token: false } },
    music_assistant: { has_token: false },
    push,
  };
}

function p8File(): File {
  const file = new File(["private-key-contents"], "AuthKey_ABCDEFGHIJ.p8");
  Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue("private-key-contents") });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSecretsStatus.mockResolvedValue({ ok: true, value: status() });
  api.setApnsCredentials.mockResolvedValue({ ok: true, value: { ok: true } });
  api.applyApnsCredentials.mockResolvedValue({ ok: true, value: { ok: true, transport: "running" } });
});

describe("SecretsPane privacy boundary", () => {
  it("renders only presence and never a returned or masked credential value", async () => {
    const { container } = render(<SecretsPane onMark={() => undefined} />);
    expect(await screen.findAllByText("Configured")).not.toHaveLength(0);
    expect(container.textContent).not.toContain("must-not-render");
    expect(container.textContent).not.toContain("••");
  });

  it.each([
    [{ has_key: false, has_key_id: false, has_team_id: false }, "Not configured"],
    [{ has_key: true, has_key_id: false, has_team_id: true }, "Incomplete"],
    [{ has_key: true, has_key_id: true, has_team_id: true }, "Configured"],
  ] as const)("reports APNs field presence %j as %s", async (push, label) => {
    api.getSecretsStatus.mockResolvedValue({ ok: true, value: status(push) });
    render(<SecretsPane onMark={() => undefined} />);

    const row = await screen.findByRole("group", { name: "Apple Push Notifications" });
    expect(row.textContent).toContain(label);
    expect(row.querySelectorAll("button")).toHaveLength(1);
    expect(row.querySelector("button")?.textContent).toBe("Update");
  });

  it("saves and applies APNs directly without adding private key data to pending Apply state", async () => {
    const onMark = vi.fn();
    render(<SecretsPane onMark={onMark} />);
    const row = await screen.findByRole("group", { name: "Apple Push Notifications" });
    fireEvent.click(row.querySelector("button") as HTMLButtonElement);
    fireEvent.input(screen.getByRole("textbox", { name: "Team ID" }), { target: { value: "1234567890" } });
    fireEvent.change(screen.getByLabelText("Apple private key file"), { target: { files: [p8File()] } });
    const save = screen.getByRole("button", { name: "Save and apply" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await screen.findByText("Credentials saved and transport running");
    expect(api.setApnsCredentials).toHaveBeenCalledExactlyOnceWith("token", {
      private_key_p8: "private-key-contents",
      key_id: "ABCDEFGHIJ",
      team_id: "1234567890",
    });
    expect(api.applyApnsCredentials).toHaveBeenCalledExactlyOnceWith("token");
    expect(onMark).not.toHaveBeenCalled();
  });
});
