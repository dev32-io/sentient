import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { VoiceFilterBar } from "./VoiceFilterBar.tsx";

describe("VoiceFilterBar", () => {
  it("keeps query, language, source, and tag state controlled by its owner", async () => {
    const onQ = vi.fn();
    const onLanguage = vi.fn();
    const onSource = vi.fn();
    const onToggleTag = vi.fn();

    render(
      <VoiceFilterBar
        q=""
        source="all"
        activeTags={[]}
        allTags={["Warm"]}
        language=""
        allLanguages={["en"]}
        onQ={onQ}
        onLanguage={onLanguage}
        onSource={onSource}
        onToggleTag={onToggleTag}
      />,
    );

    fireEvent.input(screen.getByRole("searchbox", { name: "Search voices" }), { target: { value: "calm" } });
    expect(onQ).toHaveBeenCalledWith("calm");

    fireEvent.keyDown(screen.getByRole("button", { name: /All languages/ }), { key: "ArrowDown" });
    await Promise.resolve();
    fireEvent.click(screen.getByRole("option", { name: /English/ }));
    expect(onLanguage).toHaveBeenCalledWith("en");

    fireEvent.click(screen.getByRole("button", { name: "Built-in" }));
    expect(onSource).toHaveBeenCalledWith("builtin");
    fireEvent.click(screen.getByRole("button", { name: "Warm" }));
    expect(onToggleTag).toHaveBeenCalledWith("Warm");
  });
});
