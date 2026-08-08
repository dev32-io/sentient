// gateway/webui/src/components/settings/panes/tools-pane.test.tsx
//
// PROVES the five `skill_*` gateway-native rows actually render and actually
// write, rather than assuming the projection being generic is enough. Task
// 11 (plan 2026-08-08-skill-system): the "Gateway tools" card used to ship a
// hardcoded no-op `onChange` for every native row — safe only because
// `delegateTask` was the only row and its `settable` was always `false`. Once
// `mcp-catalog.ts` started projecting `skill_list`/`skill_use`/`skill_create`/
// `skill_update`/`skill_delete` as `settable: true`, that stub silently
// discarded every dropdown change a person made on those five rows. This file
// is the rendering-level control that would have caught it: it drives the
// actual Select component, not the pure `withToolPermission` helper (already
// covered by `tool-permission-patch.test.ts`).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { McpCatalogView, ProfileApi, ProfileV1 } from "../../../services/profile-api.js";
import { ToolsPane } from "./tools-pane.tsx";

function draft(): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: "u_aaaaaaaa",
    model: { provider: "openrouter", id: "test-model" },
    voice: { provider: "local-tts", id: "test-voice" },
    audio: { ttsEnabled: true, channel: "voice" },
    persona: { template: "default", overrides: "" },
    tools: {},
    compression: { threshold: 0 },
    advanced: { extraSystemPrompt: "", maxTokens: 0, reasoningEffort: "minimal" },
  };
}

// Mirrors `gateway/src/tools/skill-tools.ts#SKILL_TOOL_SETTINGS` plus
// `delegateTask` — the exact shape `projectNativeTools` (mcp-catalog.ts)
// returns, pinned at `mcp-catalog.test.ts` lines 475-489.
function catalogWithSkillTools(): McpCatalogView {
  return {
    servers: {},
    wildcardPermissionKey: "*",
    nativeTools: [
      { name: "skill_list", description: "Let the assistant see the skills you've taught it.", tier: "read", permission: "allow", settable: true },
      { name: "skill_use", description: "Let the assistant read one of your saved skills to follow it.", tier: "read", permission: "allow", settable: true },
      { name: "skill_create", description: "Let the assistant save a new skill you teach it.", tier: "confirm", permission: "ask", settable: true },
      { name: "skill_update", description: "Let the assistant revise one of your saved skills.", tier: "confirm", permission: "ask", settable: true },
      { name: "skill_delete", description: "Let the assistant remove one of your saved skills.", tier: "confirm", permission: "ask", settable: true },
      { name: "delegateTask", description: "Hand a task to Hermes.", tier: "confirm", permission: "ask", settable: false },
    ],
    hermesBuiltins: [],
  };
}

function stubApi(catalog: McpCatalogView): ProfileApi {
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "getMcpCatalog") return async () => ({ ok: true, value: catalog });
        return async () => ({ ok: false, error: { code: "unused-in-test", message: "unused in test" } });
      },
    },
  ) as ProfileApi;
}

/** Finds a row by its rendered tool name, then the Select trigger button
 *  inside that exact row — never a page-wide role query, since every row's
 *  trigger renders the same kind of button and several share the same
 *  current-value label (e.g. every `read`-tier row starts on "Allow"). */
function rowFor(name: string): HTMLElement {
  const code = screen.getByText(name);
  const row = code.closest(".tool-row");
  if (!row) throw new Error(`no .tool-row ancestor for ${name}`);
  return row as HTMLElement;
}

describe("ToolsPane — gateway-native skill tools", () => {
  it("renders all five skill_* rows plus delegateTask under Gateway tools", async () => {
    const api = stubApi(catalogWithSkillTools());
    render(<ToolsPane api={api} token="t_test" draft={draft()} onDraftTools={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Gateway tools")).not.toBeNull());

    for (const name of ["skill_list", "skill_use", "skill_create", "skill_update", "skill_delete", "delegateTask"]) {
      expect(screen.getByText(name)).not.toBeNull();
    }
  });

  it("shows the read-tier rows resolved to Allow and the confirm-tier rows resolved to Ask", async () => {
    const api = stubApi(catalogWithSkillTools());
    render(<ToolsPane api={api} token="t_test" draft={draft()} onDraftTools={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Gateway tools")).not.toBeNull());

    for (const name of ["skill_list", "skill_use"]) {
      expect(within(rowFor(name)).getByRole("button", { name: /allow/i })).not.toBeNull();
    }
    for (const name of ["skill_create", "skill_update", "skill_delete", "delegateTask"]) {
      expect(within(rowFor(name)).getByRole("button", { name: /ask/i })).not.toBeNull();
    }
  });

  it("renders delegateTask's dropdown disabled — settable:false is structural, not a display choice", async () => {
    const api = stubApi(catalogWithSkillTools());
    render(<ToolsPane api={api} token="t_test" draft={draft()} onDraftTools={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Gateway tools")).not.toBeNull());

    const trigger = within(rowFor("delegateTask")).getByRole("button", { name: /ask/i }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  it("a skill_* row's dropdown IS enabled — settable:true actually reaches the Select", async () => {
    const api = stubApi(catalogWithSkillTools());
    render(<ToolsPane api={api} token="t_test" draft={draft()} onDraftTools={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Gateway tools")).not.toBeNull());

    const trigger = within(rowFor("skill_create")).getByRole("button", { name: /ask/i }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(false);
  });

  // THE regression control: picking "Deny" on skill_create's dropdown must
  // produce a draft PATCH keyed under the reserved `native` server namespace
  // (`NATIVE_TOOL_SERVER_KEY`, @sentient/config) — the SAME namespace
  // `resolve-tool-permission.ts` reads back server-side (T7/T8, already
  // proven at the mcp-catalog + broker level). Before this task's fix, the
  // row's `onChange` was a hardcoded no-op and `onDraftTools` was never
  // called at all.
  it("writing skill_create's dropdown to Deny patches permissions.native.skill_create = deny", async () => {
    const onDraftTools = vi.fn();
    const api = stubApi(catalogWithSkillTools());
    render(<ToolsPane api={api} token="t_test" draft={draft()} onDraftTools={onDraftTools} />);
    await waitFor(() => expect(screen.getByText("Gateway tools")).not.toBeNull());

    const row = rowFor("skill_create");
    fireEvent.click(within(row).getByRole("button", { name: /ask/i }));
    fireEvent.click(within(row).getByRole("button", { name: /deny/i }));

    expect(onDraftTools).toHaveBeenCalledTimes(1);
    const [patch] = onDraftTools.mock.calls[0] as [ProfileV1["tools"]];
    expect(patch.permissions?.native?.skill_create).toBe("deny");
  });

  it("does not disturb any other tool's stored permission when writing one skill row", async () => {
    const onDraftTools = vi.fn();
    const api = stubApi(catalogWithSkillTools());
    const seeded = draft();
    seeded.tools = { permissions: { native: { skill_use: "off" }, household: { unlock_door: "ask" } } };
    render(<ToolsPane api={api} token="t_test" draft={seeded} onDraftTools={onDraftTools} />);
    await waitFor(() => expect(screen.getByText("Gateway tools")).not.toBeNull());

    const row = rowFor("skill_create");
    fireEvent.click(within(row).getByRole("button", { name: /ask/i }));
    fireEvent.click(within(row).getByRole("button", { name: /deny/i }));

    const [patch] = onDraftTools.mock.calls[0] as [ProfileV1["tools"]];
    expect(patch.permissions?.native).toEqual({ skill_use: "off", skill_create: "deny" });
    expect(patch.permissions?.household).toEqual({ unlock_door: "ask" });
  });
});
