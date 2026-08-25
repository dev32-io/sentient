import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { McpCatalogView, ProfileApi, ProfileV1 } from "../../../services/profile-api.js";
import { ToolsPane } from "./tools-pane.tsx";

function draft(): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "u_test",
    model: { provider: "openrouter", id: "test" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" },
    memory: { spark: true, dreaming: true },
    persona: { template: "default", overrides: "" },
    tools: {},
    compression: { threshold: 0 },
    advanced: { extraSystemPrompt: "", maxTokens: 0, reasoningEffort: "minimal" },
  };
}

const CATALOG: McpCatalogView = {
  groups: {
    skills: {
      defaultExposure: "standard",
      wildcardPermission: null,
      tools: [
        { name: "skill_list", description: "List skills", tier: "read", permission: "allow", settable: true, dispatch: { kind: "native" } },
        { name: "skill_create", description: "Create a skill", tier: "confirm", permission: "ask", settable: true, dispatch: { kind: "native" } },
      ],
    },
  },
  wildcardPermissionKey: "*",
  hermesBuiltins: [],
};

function api(): ProfileApi {
  return new Proxy({}, {
    get: (_target, prop) => prop === "getMcpCatalog"
      ? async () => ({ ok: true, value: CATALOG })
      : async () => ({ ok: false, error: { code: "unused", message: "unused" } }),
  }) as ProfileApi;
}

describe("ToolsPane product groups", () => {
  it("renders native tools inside their stable product section", async () => {
    render(<ToolsPane api={api()} token="token" draft={draft()} onDraftTools={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("skills")).not.toBeNull());
    fireEvent.click(screen.getByText("skills"));
    expect(screen.getByText("skill_list")).not.toBeNull();
    expect(screen.getByText("skill_create")).not.toBeNull();
  });

  it("writes a native edit under the product group key", async () => {
    const onDraftTools = vi.fn();
    render(<ToolsPane api={api()} token="token" draft={draft()} onDraftTools={onDraftTools} />);
    await waitFor(() => expect(screen.getByText("skills")).not.toBeNull());
    fireEvent.click(screen.getByText("skills"));
    const row = screen.getByText("skill_create").closest(".tool-row");
    if (!row) throw new Error("missing row");
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /ask/i }));
    fireEvent.click(screen.getByRole("option", { name: /deny/i }));
    expect(onDraftTools).toHaveBeenCalledWith(expect.objectContaining({ permissions: { skills: { skill_create: "deny" } } }));
  });
});
