import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

const getSecretsStatus = vi.hoisted(() => vi.fn());
vi.mock("../../../hooks/use-auth.tsx", () => ({ useAuth: () => ({ status: "authenticated", token: "token", user: { isAdmin: true } }) }));
vi.mock("../../../services/admin-api.ts", () => ({ createAdminApi: () => ({ getSecretsStatus, setLlmProviderKey: vi.fn(), setActiveLlmProvider: vi.fn() }) }));

import { SecretsPane } from "./secrets-pane.tsx";

describe("SecretsPane privacy boundary", () => {
  it("renders only presence and never a returned or masked credential value", async () => {
    getSecretsStatus.mockResolvedValue({
      ok: true,
      value: {
        llm: {
          active: "openrouter",
          openrouter: { has_key: true, has_base_url: false, value: "must-not-render" },
          ollama_cloud: { has_key: false, has_base_url: false },
          custom: { has_key: true, has_base_url: true },
        },
        home_assistant: { observe_token: { has_token: false }, mcp_server_token: { has_token: false } },
        music_assistant: { has_token: false },
      },
    });
    const { container } = render(<SecretsPane onMark={() => undefined} />);
    expect(await screen.findAllByText("Configured")).not.toHaveLength(0);
    expect(container.textContent).not.toContain("must-not-render");
    expect(container.textContent).not.toContain("••");
  });
});
