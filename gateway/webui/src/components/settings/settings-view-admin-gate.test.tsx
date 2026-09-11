// The WIRING of the Admin nav gate — that the viewer's own record is what the
// sidebar is told, and nothing else.
//
// `nav-config.test.ts` pins the pure function: given `isAdmin`, which keys the
// sidebar offers. It cannot see the seam that actually decides the answer —
// `settings-view.tsx` deriving `isAdmin` from `auth.user.isAdmin` and passing
// it to `SidebarNav`. Hardcoding that prop to `true` kills no test in
// `nav-config.test.ts`, and it is exactly the defect an end-to-end run found: a
// demoted admin re-logged in and was still shown the Admin group, then left
// clicking panes that only produce 403s.
//
// Rendered, not unit-called, for the same reason: the bug lives in the JSX
// attribute, so an assertion that does not go through the render cannot fail
// on it.
//
// This is a DISPLAY decision, not an authorization one — `require-admin-auth.ts`
// re-resolves the caller's role from the record on every admin call. It is
// pinned because a UI that offers a member a door that only errors is a
// usability defect and reads, wrongly, as an escalation.

import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { AuthState } from "../../types.js";

const authState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("../../hooks/use-auth.tsx", () => ({
  useAuth: () => authState.current,
}));

// The panes fetch on mount and none of them is under test — the sidebar is
// rendered for every tab, so a pane's body is irrelevant to these cases. A
// Proxy rather than a named list of methods: which endpoint the active pane
// happens to call is not a fact this file should have to track, and a missing
// name would surface as an unhandled rejection rather than a failure.
const stubbedApi = vi.hoisted(
  () =>
    () =>
      new Proxy(
        {},
        { get: () => async () => ({ ok: false, error: { code: "stubbed", message: "stubbed in test" } }) },
      ),
);

vi.mock("../../services/profile-api.js", () => ({ createProfileApi: stubbedApi }));
vi.mock("../../services/providers-api.ts", () => ({ createProvidersApi: stubbedApi }));

import { SettingsView } from "./settings-view.tsx";

function signedInAs(isAdmin: boolean): void {
  authState.current = {
    status: "authenticated",
    token: "t_token",
    user: { userId: "u_aaaaaaaa", displayName: "Ada", isAdmin, avatarTint: "#fff" },
  } as unknown as AuthState;
}

/** The two panes the Admin group exists to offer. Both, not one: a gate that
 *  hides Members and leaks Secrets is still broken. */
const ADMIN_TABS = [/members/i, /secrets/i];

describe("SettingsView — the Admin nav gate", () => {
  it("offers the Admin panes to a viewer whose record says admin", () => {
    signedInAs(true);
    render(<SettingsView />);
    for (const label of ADMIN_TABS) expect(screen.queryByRole("button", { name: label })).not.toBeNull();
  });

  it("SECURITY-ADJACENT: offers a member no Admin pane at all", () => {
    signedInAs(false);
    render(<SettingsView />);
    for (const label of ADMIN_TABS) expect(screen.queryByRole("button", { name: label })).toBeNull();
  });

  // The gate must be exactly as wide as the Admin group — over-applying it is
  // as wrong as under-applying it, and just as silent.
  it("still offers a member every non-admin pane", () => {
    signedInAs(false);
    render(<SettingsView />);
    expect(screen.queryByRole("button", { name: /account/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /tools/i })).not.toBeNull();
  });

  // Before auth settles there is no record to read, and a sidebar that guessed
  // "admin" for the split second before one arrives would be the same defect
  // with a shorter fuse. Asserted as "the view is EMPTY" rather than "these two
  // labels are absent": an absence assertion holds for a view that rendered
  // nothing, so it could never tell the designed behaviour from a crash.
  it("draws nothing at all until auth settles, so no pane can appear early", () => {
    authState.current = { status: "unauthenticated" } as unknown as AuthState;
    const { container } = render(<SettingsView />);
    expect(container.textContent).toBe("");
  });

  it("exposes a narrow overview-to-pane transition and restores focus from its Settings back action", async () => {
    signedInAs(false);
    const { container } = render(<SettingsView />);
    const shell = container.querySelector(".settings-v2");
    expect(shell?.getAttribute("data-narrow-pane-open")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Get the app" }));
    expect(shell?.getAttribute("data-narrow-pane-open")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    expect(shell?.getAttribute("data-narrow-pane-open")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Get the app" })));
  });
});
