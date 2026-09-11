import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { SidebarNav } from "./sidebar-nav.tsx";

describe("SidebarNav", () => {
  it("exposes exactly one current page and preserves dirty state in its accessible name", () => {
    render(
      <SidebarNav
        active="memory"
        dirtyKeys={new Set(["memory"])}
        isAdmin={false}
        onChange={() => {}}
      />,
    );

    const current = screen.getByRole("button", { name: "Memory, changed" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(document.querySelectorAll('.s-nav-i[aria-current="page"]')).toHaveLength(1);
    expect(current.querySelector(".dot-dirty")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps native button activation delegated to the routing owner", () => {
    const onChange = vi.fn();
    render(
      <SidebarNav
        active="memory"
        dirtyKeys={new Set()}
        isAdmin={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith("account");
  });
});
