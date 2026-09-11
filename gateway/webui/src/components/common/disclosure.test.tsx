import { fireEvent, render } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { Disclosure } from "./composites.tsx";

describe("Disclosure", () => {
  it("keeps native details semantics and synchronizes its expanded relationship", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <Disclosure title="Advanced options" description="Additional controls" onOpenChange={onOpenChange}>
        <p>Details</p>
      </Disclosure>,
    );
    const details = container.querySelector("details");
    const summary = container.querySelector("summary");
    const body = container.querySelector<HTMLDivElement>(".snt-disclosure__body");
    if (!details || !summary || !body) throw new Error("missing disclosure anatomy");

    expect(details.open).toBe(false);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(summary.getAttribute("aria-controls")).toBe(body.id);

    fireEvent.click(summary);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(details.open).toBe(true);
    expect(summary.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(summary);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(details.open).toBe(false);
    expect(summary.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the button adapter native for product-owned button disclosures", () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <Disclosure mode="button" title="Capabilities" onOpenChange={onOpenChange}>
        <p>Tools</p>
      </Disclosure>,
    );
    const trigger = container.querySelector("button");
    const body = container.querySelector<HTMLDivElement>(".snt-disclosure__body");
    if (!trigger || !body) throw new Error("missing button disclosure anatomy");

    expect(container.querySelector("details")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(body.id);
    expect(body.hidden).toBe(true);

    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
  });

  it("completes controlled changes immediately when Reduced Motion is requested", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, media: "(prefers-reduced-motion: reduce)" })),
    });
    try {
      const { container, rerender } = render(
        <Disclosure title="Data and storage" open={false} onOpenChange={() => {}}>
          <p>Storage controls</p>
        </Disclosure>,
      );
      const details = container.querySelector("details");
      if (!details) throw new Error("missing details");
      rerender(
        <Disclosure title="Data and storage" open onOpenChange={() => {}}>
          <p>Storage controls</p>
        </Disclosure>,
      );
      expect(details.open).toBe(true);
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
    }
  });
});
