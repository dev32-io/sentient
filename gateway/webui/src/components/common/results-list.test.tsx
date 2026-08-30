import { fireEvent, render, screen, within } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { ResultsList, type ResultsListProps } from "./composites.tsx";

function props(overrides: Partial<ResultsListProps> = {}): ResultsListProps {
  return {
    countLabel: "2 results",
    summary: "Filtered results",
    clearLabel: "Clear filters",
    items: [
      { id: "one", leading: "A", title: "First result", detail: "Ready", onActivate: vi.fn() },
      { id: "two", leading: "B", title: "Second result", detail: "Shared", onActivate: vi.fn() },
    ],
    pageLabel: "Page 1 of 2",
    previousLabel: "Previous",
    loadMoreLabel: "Load more",
    loadingLabel: "Loading…",
    onClear: vi.fn(),
    onPrevious: vi.fn(),
    onLoadMore: vi.fn(),
    previousDisabled: true,
    ...overrides,
  };
}

describe("ResultsList", () => {
  it("keeps rows as native list actions and delegates activation", () => {
    const input = props();
    render(<ResultsList {...input} />);

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /First result Ready/ }));
    expect(input.items[0]?.onActivate).toHaveBeenCalledOnce();
  });

  it("preserves disabled pagination and the localized loading label", () => {
    render(<ResultsList {...props({ loadingMore: true })} />);

    expect(screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Loading…" }).hasAttribute("disabled")).toBe(true);
  });
});
