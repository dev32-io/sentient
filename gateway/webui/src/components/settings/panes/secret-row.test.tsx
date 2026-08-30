import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
import { SecretRow } from "./secret-row.tsx";

function SecretRowHarness() {
  const [editing, setEditing] = useState(false);
  return (
    <SecretRow
      label="OpenRouter"
      status={{ has_key: true }}
      editing={editing}
      onStartEdit={() => setEditing(true)}
      onCancel={() => setEditing(false)}
      onSave={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

describe("SecretRow", () => {
  it("keeps stored values presence-only and restores focus after cancel", async () => {
    const { container } = render(<SecretRowHarness />);

    expect(screen.getAllByText("Configured")).toHaveLength(2);
    expect(container.textContent).not.toContain("••");

    const edit = screen.getByRole("button", { name: "Edit" });
    fireEvent.click(edit);

    const input = screen.getByLabelText("New OpenRouter key") as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    expect(input.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(screen.queryByLabelText("New OpenRouter key")).toBeNull();
  });
});
