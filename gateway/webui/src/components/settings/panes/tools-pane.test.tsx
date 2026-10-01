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
        { name: "fixed_tool", description: "Fixed", tier: "read", permission: "allow", settable: false, dispatch: { kind: "native" } },
        { name: "skill_create", description: "Create a skill", tier: "confirm", permission: "ask", settable: true, dispatch: { kind: "native" } },
        { name: "delegateTask", description: "Delegate", tier: "confirm", permission: "allow", settable: true, dispatch: { kind: "native" } },
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
    expect(screen.getAllByText("skill_list")).toHaveLength(2);
    expect(screen.getAllByText("skill_create")).toHaveLength(2);
  });

  it("shows Cube default Off independently of ordinary catalog and writes global tool names", async () => {
    const onDraftTools = vi.fn();
    const profile = draft();
    profile.tools.permissions = { skills: { skill_list: "allow" }, cube: { "*": "ask", skill_create: "deny" } };
    const { rerender } = render(<ToolsPane api={api()} token="token" draft={profile} onDraftTools={onDraftTools} />);
    await screen.findByText("Cube");
    const cube = screen.getByText("Cube").closest(".snt-plate");
    if (!cube) throw new Error("missing Cube card");
    const row = within(cube as HTMLElement).getByText("skill_create").closest(".tool-row");
    if (!row) throw new Error("missing Cube row");
    const choice = within(row as HTMLElement).getByRole("combobox") as HTMLSelectElement;
    expect(choice.value).toBe("off");
    expect([...choice.options].map((o) => o.value)).toEqual(["allow", "off"]);
    expect(onDraftTools).not.toHaveBeenCalled();
    const fixed = within(cube as HTMLElement).getByText("fixed_tool").closest(".tool-row");
    expect((within(fixed as HTMLElement).getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(choice, { target: { value: "ask" } });
    expect(onDraftTools).not.toHaveBeenCalled();
    fireEvent.change(choice, { target: { value: "off" } });
    expect(onDraftTools).toHaveBeenLastCalledWith(expect.objectContaining({ permissions: {
      skills: { skill_list: "allow" }, cube: { "*": "ask", skill_create: "off" },
    } }));
    const delegate = within(cube as HTMLElement).getByText("delegateTask").closest(".tool-row");
    if (!delegate) throw new Error("missing delegation row");
    expect(within(delegate as HTMLElement).getByText(/broader per-user access/)).not.toBeNull();
    fireEvent.change(within(delegate as HTMLElement).getByRole("combobox"), { target: { value: "allow" } });
    expect(onDraftTools).toHaveBeenLastCalledWith(expect.objectContaining({ permissions: {
      skills: { skill_list: "allow" }, cube: { "*": "ask", skill_create: "deny", delegateTask: "allow" },
    } }));
    rerender(<ToolsPane api={api()} token="token" draft={draft()} onDraftTools={onDraftTools} />);
    const defaultRow = within(screen.getByText("Cube").closest(".snt-plate") as HTMLElement).getByText("skill_list").closest(".tool-row");
    expect((within(defaultRow as HTMLElement).getByRole("combobox") as HTMLSelectElement).value).toBe("off");
    expect([...((within(defaultRow as HTMLElement).getByRole("combobox") as HTMLSelectElement).options)].map((o) => o.value)).toEqual(["allow", "off"]);
  });

  it("writes a native edit under the product group key", async () => {
    const onDraftTools = vi.fn();
    render(<ToolsPane api={api()} token="token" draft={draft()} onDraftTools={onDraftTools} />);
    await waitFor(() => expect(screen.getByText("skills")).not.toBeNull());
    fireEvent.click(screen.getByText("skills"));
    const row = screen.getAllByText("skill_create")[0]?.closest(".tool-row");
    if (!row) throw new Error("missing row");
    const permission = within(row as HTMLElement).getByRole("combobox", { name: "skill_create permission" });
    for (const value of ["allow", "ask", "deny", "off"] as const) {
      fireEvent.change(permission, { target: { value } });
      expect(onDraftTools).toHaveBeenLastCalledWith(expect.objectContaining({ permissions: { skills: { skill_create: value } } }));
    }
    expect(screen.queryByText(/Hermes/i)).toBeNull();
  });
});
