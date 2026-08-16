import { describe, expect, it } from "bun:test";
import type { NativeToolRunner } from "../tool-broker.js";
import { MusicAdapterError } from "./music-adapter.js";
import type {
  MusicAdapter,
  MusicCommandResult,
  MusicMedia,
  MusicPlayer,
  MusicPlayerStatus,
  MusicQueue,
  MusicTransportAction,
} from "./music-adapter.js";
import { createMusicTools } from "./music-tools.js";

const kitchen: MusicPlayer = {
  id: "p-kitchen",
  name: "Kitchen",
  available: true,
  powered: true,
  state: "playing",
  volume: 35,
  muted: false,
  groupMemberIds: [],
  activeSource: "p-kitchen",
};
const living: MusicPlayer = {
  id: "p-living",
  name: "Living Room",
  available: true,
  powered: true,
  state: "idle",
  volume: 20,
  muted: false,
  groupMemberIds: [],
  activeSource: null,
};
const livingSpeaker: MusicPlayer = { ...living, id: "p-living-speaker", name: "Living Room Speaker" };
const track: MusicMedia = {
  id: "library://track/1",
  uri: "library://track/1",
  type: "track",
  name: "Song",
  provider: "library",
  artist: "Artist",
  album: "Album",
  available: true,
  browsable: false,
};

class FakeAdapter implements MusicAdapter {
  players = [kitchen, living, livingSpeaker];
  readonly mutations: Array<{ method: string; args: unknown[] }> = [];
  commandOutcome: MusicCommandResult = { outcome: "completed" };
  commandError: MusicAdapterError | null = null;
  async search(): Promise<readonly MusicMedia[]> {
    return [track];
  }
  async browse(): Promise<readonly MusicMedia[]> {
    return [{ ...track, type: "folder", browsable: true }];
  }
  async listPlayers(): Promise<readonly MusicPlayer[]> {
    return this.players;
  }
  async playerStatus(playerId: string): Promise<MusicPlayerStatus> {
    return {
      player: this.players.find((player) => player.id === playerId) as MusicPlayer,
      queueId: playerId,
      nowPlaying: { media: track, positionSeconds: 5, durationSeconds: 180 },
    };
  }
  async queue(playerId: string): Promise<MusicQueue> {
    return {
      id: playerId,
      name: "Kitchen queue",
      state: "playing",
      currentIndex: 0,
      positionSeconds: 5,
      durationSeconds: 180,
      items: [{ id: "q1", index: 0, media: track, available: true }],
      truncated: false,
    };
  }
  async play(
    playerId: string,
    mediaUri: string,
    queueMode: "replace" | "add" | "play_next",
  ): Promise<MusicCommandResult> {
    return this.record("play", playerId, mediaUri, queueMode);
  }
  async transport(
    playerId: string,
    action: MusicTransportAction,
    position: number | null,
  ): Promise<MusicCommandResult> {
    return this.record("transport", playerId, action, position);
  }
  async setVolume(playerId: string, volume: number): Promise<MusicCommandResult> {
    return this.record("setVolume", playerId, volume);
  }
  async transfer(source: string, target: string, autoPlay: boolean): Promise<MusicCommandResult> {
    return this.record("transfer", source, target, autoPlay);
  }
  async group(target: string, members: readonly string[]): Promise<MusicCommandResult> {
    return this.record("group", target, members);
  }
  async ungroup(players: readonly string[]): Promise<MusicCommandResult> {
    return this.record("ungroup", players);
  }
  private record(method: string, ...args: unknown[]): MusicCommandResult {
    this.mutations.push({ method, args });
    if (this.commandError) throw this.commandError;
    return this.commandOutcome;
  }
}

function byName(tools: readonly NativeToolRunner[], name: string): NativeToolRunner {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}
async function run(tool: NativeToolRunner, args: Record<string, unknown>) {
  return tool.run(args, { signal: new AbortController().signal });
}
function parsed(result: { content: string }): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>;
}

describe("native music tools", () => {
  it("registers compact standard primitives without granular queue administration", () => {
    const tools = createMusicTools(new FakeAdapter());
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "music_search",
      "music_browse",
      "music_players",
      "music_status",
      "music_queue",
      "music_play",
      "music_play_media",
      "music_transport",
      "music_volume",
      "music_transfer",
      "music_group",
    ]);
    expect(
      tools.every((tool) => tool.definition.productGroup === "music" && tool.definition.defaultExposure === "standard"),
    ).toBe(true);
    expect(tools.some((tool) => /insert|remove_item|reorder|configure/.test(tool.definition.name))).toBe(false);
    expect(tools.slice(0, 5).every((tool) => tool.definition.tier === "read")).toBe(true);
    expect(tools.slice(5).every((tool) => tool.definition.tier === "write")).toBe(true);
  });

  it("returns stable search/browse identities and observational records", async () => {
    const tools = createMusicTools(new FakeAdapter());
    expect(parsed(await run(byName(tools, "music_search"), { query: "song" }))).toMatchObject({
      outcome: "ok",
      items: [{ id: "library://track/1", uri: "library://track/1" }],
    });
    expect(parsed(await run(byName(tools, "music_browse"), {}))).toMatchObject({
      outcome: "ok",
      items: [{ browsable: true }],
    });
    expect(parsed(await run(byName(tools, "music_players"), {}))).toMatchObject({ outcome: "ok", count: 3 });
    expect(parsed(await run(byName(tools, "music_status"), { player: "Kitchen" }))).toMatchObject({
      outcome: "ok",
      status: { player: { id: "p-kitchen" }, nowPlaying: { media: { id: "library://track/1" } } },
    });
    expect(parsed(await run(byName(tools, "music_queue"), { player: "p-kitchen" }))).toMatchObject({
      outcome: "ok",
      queue: { id: "p-kitchen", items: [{ id: "q1" }] },
    });
  });

  it("exposes ambiguity and not-found without dispatching a mutation", async () => {
    const adapter = new FakeAdapter();
    const play = byName(createMusicTools(adapter), "music_play_media");
    expect(parsed(await run(play, { player: "living", media_id: track.id }))).toMatchObject({
      outcome: "ambiguous",
      matches: [{ id: "p-living" }, { id: "p-living-speaker" }],
    });
    expect(parsed(await run(play, { player: "garage", media_id: track.id }))).toEqual({
      outcome: "not_found",
      player: "garage",
    });
    expect(adapter.mutations).toEqual([]);
  });

  it("direct play, transport, volume, transfer and grouping return semantic outcomes", async () => {
    const adapter = new FakeAdapter();
    const tools = createMusicTools(adapter);
    expect(
      parsed(await run(byName(tools, "music_play_media"), { player: "Kitchen", media_id: track.id })),
    ).toMatchObject({
      outcome: "completed",
      player: { id: "p-kitchen" },
    });
    expect(
      parsed(await run(byName(tools, "music_transport"), { player: "Kitchen", action: "seek", position_seconds: 30 })),
    ).toMatchObject({ outcome: "completed", action: "seek" });
    expect(parsed(await run(byName(tools, "music_volume"), { player: "Kitchen", volume: 42 }))).toMatchObject({
      outcome: "completed",
      volume: 42,
    });
    expect(
      parsed(await run(byName(tools, "music_transfer"), { source_player: "Kitchen", target_player: "p-living" })),
    ).toMatchObject({ outcome: "completed", source: { id: "p-kitchen" }, target: { id: "p-living" } });
    expect(
      parsed(
        await run(byName(tools, "music_group"), { action: "join", target_player: "Kitchen", players: ["p-living"] }),
      ),
    ).toMatchObject({ outcome: "completed", action: "join" });
    expect(parsed(await run(byName(tools, "music_group"), { action: "leave", players: ["p-living"] }))).toMatchObject({
      outcome: "completed",
      action: "leave",
    });
    expect(adapter.mutations.map((entry) => entry.method)).toEqual([
      "play",
      "transport",
      "setVolume",
      "transfer",
      "group",
      "ungroup",
    ]);
  });

  it("preserves accepted_unverified semantic outcomes", async () => {
    const adapter = new FakeAdapter();
    adapter.commandOutcome = { outcome: "accepted_unverified" };
    const result = await run(byName(createMusicTools(adapter), "music_volume"), { player: "Kitchen", volume: 25 });
    expect(result.isError).toBe(false);
    expect(parsed(result)).toMatchObject({ outcome: "accepted_unverified" });
  });

  it("preserves typed mutation failures as semantic tool outcomes", async () => {
    const cases = [
      { error: new MusicAdapterError("upstream", "denied", true), outcome: "rejected" },
      { error: new MusicAdapterError("protocol", "bad response", false), outcome: "failed" },
      { error: new MusicAdapterError("unavailable", "down", false), outcome: "unavailable" },
      { error: new MusicAdapterError("cancelled", "cancelled", true), outcome: "accepted_unverified" },
    ] as const;

    for (const testCase of cases) {
      const adapter = new FakeAdapter();
      adapter.commandError = testCase.error;
      const result = await run(byName(createMusicTools(adapter), "music_volume"), {
        player: "Kitchen",
        volume: 25,
      });
      expect(result.isError).toBe(false);
      expect(parsed(result)).toMatchObject({ outcome: testCase.outcome });
      expect(adapter.mutations).toHaveLength(1);
    }
  });
});
