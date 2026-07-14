import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceList } from "./VoiceList.tsx";

afterEach(cleanup);

describe("VoiceList", () => {
  it("renders the empty state when there are no voices", () => {
    render(
      <VoiceList
        voices={[]}
        loading={false}
        error={null}
        activeId="default"
        busy={false}
        onSetActive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(/No voices/)).toBeTruthy();
  });

  it("renders names and exactly one active marker for a populated list", () => {
    render(
      <VoiceList
        voices={[
          { voiceId: "v-1", name: "Dad", createdAt: 1, refDurationMs: 12000 },
          { voiceId: "v-2", name: "Mom", createdAt: 2, refDurationMs: 15000 },
        ]}
        loading={false}
        error={null}
        activeId="v-2"
        busy={false}
        onSetActive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Dad")).toBeTruthy();
    expect(screen.getByText("Mom")).toBeTruthy();
    expect(screen.getAllByText("active")).toHaveLength(1);
  });
});
