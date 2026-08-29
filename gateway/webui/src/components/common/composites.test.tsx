import { render, screen } from "@testing-library/preact";
import { describe, expect, it } from "vitest";
import { AsyncState } from "./composites.tsx";

describe("AsyncState loading", () => {
  it("names the loading status and keeps its progress cue decorative", () => {
    render(<AsyncState state="loading" title="Loading" message="Fetching current settings…" />);

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("heading", { name: "Loading" })).toBeTruthy();
    expect(screen.getByText("Fetching current settings…")).toBeTruthy();
    expect(status.querySelector(".snt-async-state__spinner")?.getAttribute("aria-hidden")).toBe("true");
    expect(status.querySelector("progress")).toBeNull();
  });
});
