import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { VoiceSummary } from "../../services/voices-api.ts";
import { VoicePackGrid } from "./VoicePackGrid.tsx";

const voice: VoiceSummary = {
  voiceId: "voice-1",
  name: "A deliberately long household voice label that must remain available at narrow widths",
  description: "Warm and clear",
  source: "builtin",
  tags: ["warm"],
  language: "en",
  createdAt: 1,
  refDurationMs: 10_000,
};

function props(overrides: Partial<Parameters<typeof VoicePackGrid>[0]> = {}): Parameters<typeof VoicePackGrid>[0] {
  return {
    packs: [voice], loading: false, error: null, activeId: "", previewId: null,
    previewLoadingId: null, previewDisabled: false, busy: false,
    onPlay: vi.fn(), onPick: vi.fn(), onDelete: vi.fn(), ...overrides,
  };
}

describe("voice library states", () => {
  it("renders loading, error, and empty filter states without activating audio", () => {
    const { rerender } = render(<VoicePackGrid {...props({ loading: true, packs: [] })} />);
    expect(screen.getByText("Loading voices")).not.toBeNull();
    rerender(<VoicePackGrid {...props({ error: "Try again", packs: [] })} />);
    expect(screen.getByText("Couldn't load voices")).not.toBeNull();
    rerender(<VoicePackGrid {...props({ packs: [] })} />);
    expect(screen.getByText("No voices match")).not.toBeNull();
  });

  it("exposes preview loading, playing, disabled, active, and long-label states without playback", () => {
    const onPlay = vi.fn();
    const { rerender } = render(<VoicePackGrid {...props({ previewLoadingId: voice.voiceId, onPlay })} />);
    expect(screen.getByRole("button", { name: /loading preview/i }).hasAttribute("disabled")).toBe(true);
    rerender(<VoicePackGrid {...props({ previewId: voice.voiceId, activeId: voice.voiceId, onPlay })} />);
    const stop = screen.getByRole("button", { name: /stop preview/i });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(voice.name)).not.toBeNull();
    fireEvent.click(stop);
    expect(onPlay).toHaveBeenCalledWith(voice.voiceId, voice.language);
  });
});
