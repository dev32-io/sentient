import { describe, expect, it } from "bun:test";
import type { NativeToolRunner } from "../tool-broker.js";
import type {
  MusicAdapter,
  MusicCommandResult,
  MusicMedia,
  MusicPlayer,
  MusicPlayerStatus,
  MusicQueue,
  MusicQueueMode,
  MusicTransportAction,
} from "./music-adapter.js";
import { MUSIC_TOOL_SETTINGS, createMusicTools } from "./music-tools.js";

const media: MusicMedia = {
  id: "lofi-1",
  uri: "library://lofi/1",
  type: "playlist",
  name: "Lo-Fi Focus",
  provider: "library",
  artist: null,
  album: null,
  available: true,
  browsable: false,
};
const room: MusicPlayer = {
  id: "room-1",
  name: "Living Room",
  available: true,
  powered: true,
  state: "playing",
  volume: 30,
  muted: false,
  groupMemberIds: [],
  activeSource: null,
};

class Adapter implements MusicAdapter {
  mutations: Array<{ player: string; uri: string; mode: MusicQueueMode }> = [];
  async search(): Promise<readonly MusicMedia[]> {
    return [media];
  }
  async browse(): Promise<readonly MusicMedia[]> {
    return [];
  }
  async listPlayers(): Promise<readonly MusicPlayer[]> {
    return [room];
  }
  async playerStatus(): Promise<MusicPlayerStatus> {
    return { player: room, queueId: room.id, nowPlaying: { media, positionSeconds: 1, durationSeconds: 100 } };
  }
  async queue(): Promise<MusicQueue> {
    return {
      id: room.id,
      name: room.name,
      state: "playing",
      currentIndex: 0,
      positionSeconds: 1,
      durationSeconds: 100,
      items: [{ id: "item-1", index: 0, media, available: true }],
      truncated: false,
    };
  }
  async play(player: string, uri: string, mode: MusicQueueMode): Promise<MusicCommandResult> {
    this.mutations.push({ player, uri, mode });
    return { outcome: "accepted" };
  }
  async transport(
    _player: string,
    _action: MusicTransportAction,
    _position: number | null,
  ): Promise<MusicCommandResult> {
    return { outcome: "completed" };
  }
  async setVolume(): Promise<MusicCommandResult> {
    return { outcome: "completed" };
  }
  async transfer(): Promise<MusicCommandResult> {
    return { outcome: "completed" };
  }
  async group(): Promise<MusicCommandResult> {
    return { outcome: "completed" };
  }
  async ungroup(): Promise<MusicCommandResult> {
    return { outcome: "completed" };
  }
}

function tool(adapter: Adapter): NativeToolRunner {
  const found = createMusicTools(adapter).find((candidate) => candidate.definition.name === "music_play");
  if (!found) throw new Error("music_play not registered");
  return found;
}

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

describe("music_play tool contract", () => {
  it("publishes one compact write tool with disclosed replace/start-now default", () => {
    const runner = tool(new Adapter());
    expect(runner.definition.tier).toBe("write");
    expect(runner.definition.productGroup).toBe("music");
    expect(runner.definition.defaultExposure).toBe("standard");
    expect(runner.definition.parameters).toMatchObject({
      required: ["request", "player"],
      properties: { queue_mode: { default: "replace" } },
    });
    expect(runner.definition.description).toContain("replaces the active queue and starts playback now");
    expect(MUSIC_TOOL_SETTINGS.find(({ name }) => name === "music_play")?.description).toContain(
      "replaces the room's active queue",
    );
  });

  it("composes search, resolution, mutation and verification behind one invocation", async () => {
    const adapter = new Adapter();
    const runner = tool(adapter);
    expect(runner.validate?.({ request: "some lo-fi music", player: "Living Room" })).toBeNull();
    const result = await runner.run(
      { request: "some lo-fi music", player: "Living Room" },
      { signal: new AbortController().signal },
    );
    expect(result.isError).toBe(false);
    expect(parse(result.content)).toMatchObject({
      outcome: "playing",
      queueMode: "replace",
      player: { id: "room-1" },
      media: { id: "lofi-1" },
    });
    expect(adapter.mutations).toEqual([{ player: "room-1", uri: "library://lofi/1", mode: "replace" }]);
  });

  it("keeps search, browse, status, queue, and direct selection primitives available", () => {
    const names = createMusicTools(new Adapter()).map(({ definition }) => definition.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "music_search",
        "music_browse",
        "music_status",
        "music_queue",
        "music_play_media",
        "music_transport",
        "music_transfer",
      ]),
    );
  });
});
