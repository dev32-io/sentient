import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { createRef } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceAction } from "./foundation.tsx";

afterEach(cleanup);

describe("content-hosted action native boundary", () => {
  it("preserves DOM refs, event targets, keyboard handlers and controlled ARIA state", () => {
    const ref = createRef<HTMLButtonElement>();
    const onOpen = vi.fn();
    const onKey = vi.fn();
    const { rerender } = render(
      <SurfaceAction buttonRef={ref} aria-label="Open date" aria-pressed={false} aria-haspopup="dialog"
        data-date="2026-06-01" onClick={(event) => onOpen(event.currentTarget)}
        onKeyDown={(event) => onKey(event.key, event.currentTarget)}>
        <span>1</span>
      </SurfaceAction>,
    );
    const button = screen.getByRole("button", { name: "Open date" }) as HTMLButtonElement;
    expect(ref.current).toBe(button);
    expect(button.type).toBe("button");
    expect(button.dataset.date).toBe("2026-06-01");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(onKey).toHaveBeenCalledWith("ArrowRight", button);
    fireEvent.click(screen.getByText("1"));
    expect(onOpen).toHaveBeenCalledWith(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    rerender(<SurfaceAction buttonRef={ref} aria-label="Open date" aria-pressed={true}>1</SurfaceAction>);
    expect(ref.current).toBe(button);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("uses native disabled and explicit form-submit behavior, without accidental submission", () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn();
    render(<form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <SurfaceAction disabled onClick={onClick}>Unavailable</SurfaceAction>
      <SurfaceAction onClick={onClick}>Open</SurfaceAction>
      <SurfaceAction type="submit" name="intent" value="save">Save</SurfaceAction>
    </form>);
    const disabled = screen.getByRole("button", { name: "Unavailable" }) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    disabled.click();
    expect(onClick).not.toHaveBeenCalled();
    (screen.getByRole("button", { name: "Open" }) as HTMLButtonElement).click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
