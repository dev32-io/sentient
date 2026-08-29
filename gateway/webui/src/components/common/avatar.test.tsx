import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./avatar.tsx";

afterEach(cleanup);

describe("Avatar", () => {
  it("keeps user initials and tint on the native image role", () => {
    render(<Avatar kind="user" initial=" maya " name="Maya Chen" tint="sage" size="xl" />);

    const avatar = screen.getByRole("img", { name: "Maya Chen" });
    expect(avatar.classList.contains("snt-avatar--user")).toBe(true);
    expect(avatar.classList.contains("snt-avatar--sage")).toBe(true);
    expect(avatar.classList.contains("snt-avatar--xl")).toBe(true);
    expect(avatar.querySelector('[aria-hidden="true"]')?.textContent).toBe("MA");
  });

  it("uses the public fallback path and its neutral material variant", () => {
    render(<Avatar kind="user" name="Unknown user" tint="terra" size="lg" />);

    const avatar = screen.getByRole("img", { name: "Unknown user" });
    expect(avatar.classList.contains("snt-avatar--fallback")).toBe(true);
    expect(avatar.classList.contains("snt-avatar--terra")).toBe(false);
    expect(avatar.querySelector('[aria-hidden="true"]')?.textContent).toBe("?");
  });

  it("announces selected state and preserves disabled semantics", () => {
    render(<Avatar kind="user" initial="M" name="Unavailable user" selected disabled size="lg" />);

    const avatar = screen.getByRole("img", { name: "Unavailable user, selected" });
    expect(avatar.classList.contains("snt-avatar--selected")).toBe(true);
    expect(avatar.getAttribute("aria-disabled")).toBe("true");
  });
});
