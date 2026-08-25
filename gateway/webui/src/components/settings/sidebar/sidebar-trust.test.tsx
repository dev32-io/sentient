import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../hooks/use-system-readiness.ts", () => ({ useSystemReadiness: () => true }));
import { SidebarNav } from "./sidebar-nav.tsx";
import { SidebarStatus } from "./sidebar-status.tsx";

describe("ordinary Settings navigation trust boundary", () => {
  it("contains no implementation names or versions and links to Diagnostics", () => {
    const { container } = render(<div><SidebarNav active="account" onChange={() => undefined} dirtyKeys={new Set()} isAdmin={false} /><SidebarStatus token="token" /></div>);
    expect(container.textContent).not.toMatch(/Hermes|STT|TTS|v\d/i);
    expect(screen.getByRole("button", { name: "Diagnostics" })).not.toBeNull();
    expect(screen.getByTestId("settings-household-status").textContent).toContain("Household services ready");
  });
});
