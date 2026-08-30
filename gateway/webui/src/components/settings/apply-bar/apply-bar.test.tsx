import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyBar } from "./apply-bar.tsx";
import type { ApplyDeps } from "./apply-bar-machine.ts";

function deps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    saveSoul: async () => ({ ok: true }),
    saveMemoryDoc: async () => ({ ok: true }),
    saveProfile: async () => ({ ok: true }),
    savePersonalityActive: async () => ({ ok: true }),
    savePersonalityBody: async () => ({ ok: true }),
    savePersonalityCreate: async () => ({ ok: true }),
    savePersonalityDelete: async () => ({ ok: true }),
    waitForRestart: async () => ({ state: "ready", elapsedMs: 0 }),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("ApplyBar", () => {
  it("maps the real apply lifecycle to visible state without changing action semantics", async () => {
    let finishApply: ((value: { state: "ready"; elapsedMs: number }) => void) | undefined;
    const waitForRestart = () => new Promise<{ state: "ready"; elapsedMs: number }>((resolve) => {
      finishApply = resolve;
    });
    const onApplied = vi.fn();
    const onDiscard = vi.fn();

    render(
      <ApplyBar
        pending={[{ key: "systemPrompt.soul", kind: "slow", payload: "updated" }]}
        deps={deps({ waitForRestart })}
        onApplied={onApplied}
        onDiscard={onDiscard}
      />,
    );

    const status = screen.getByRole("status");
    expect(status.dataset.state).toBe("dirty");
    expect(status.querySelector(".ab-marker")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(status.dataset.state).toBe("applying"));
    expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Applying…" }) as HTMLButtonElement).disabled).toBe(true);

    finishApply?.({ state: "ready", elapsedMs: 12 });
    await waitFor(() => expect(status.dataset.state).toBe("done"));
    expect(screen.getByText("Changes applied")).toBeTruthy();
    expect(screen.getByText("The household preference is up to date.")).toBeTruthy();
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
