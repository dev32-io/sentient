import { describe, expect, it } from "bun:test";
import type { MusicPlayer } from "./music-adapter.js";
import { resolveMusicPlayer } from "./music-resolver.js";

function player(id: string, name: string): MusicPlayer {
  return {
    id,
    name,
    available: true,
    powered: true,
    state: "idle",
    volume: 20,
    muted: false,
    groupMemberIds: [],
    activeSource: null,
  };
}

const players = [
  player("stable-kitchen", "Kitchen"),
  player("stable-living", "Living Room"),
  player("stable-living-speaker", "Living Room Speaker"),
];

describe("resolveMusicPlayer", () => {
  it("prefers stable IDs and normalized exact names", () => {
    expect(resolveMusicPlayer(players, "stable-kitchen")).toMatchObject({
      kind: "resolved",
      player: { id: "stable-kitchen" },
    });
    expect(resolveMusicPlayer(players, "  KITCHEN ")).toMatchObject({
      kind: "resolved",
      player: { id: "stable-kitchen" },
    });
  });

  it("resolves a unique partial natural room name", () => {
    expect(resolveMusicPlayer(players, "speaker")).toMatchObject({
      kind: "resolved",
      player: { id: "stable-living-speaker" },
    });
  });

  it("returns explicit ambiguity instead of guessing", () => {
    expect(resolveMusicPlayer(players, "living")).toEqual({
      kind: "ambiguous",
      query: "living",
      matches: [
        { id: "stable-living", name: "Living Room" },
        { id: "stable-living-speaker", name: "Living Room Speaker" },
      ],
    });
  });

  it("returns explicit not-found", () => {
    expect(resolveMusicPlayer(players, "garage")).toEqual({ kind: "not_found", query: "garage" });
  });
});
