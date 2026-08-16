import { describe, expect, it } from "bun:test";
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
import { MusicAdapterError } from "./music-adapter.js";
import { runMusicPlay } from "./music-play-state-machine.js";

const lofi: MusicMedia = {
  id: "track-1",
  uri: "library://track/1",
  type: "track",
  name: "Lo-Fi Beats",
  provider: "library",
  artist: "Focus Artist",
  album: "Quiet Work",
  available: true,
  browsable: false,
};
const player: MusicPlayer = {
  id: "living-1",
  name: "Living Room",
  available: true,
  powered: true,
  state: "idle",
  volume: 20,
  muted: false,
  groupMemberIds: [],
  activeSource: null,
};

class FakeMusicAdapter implements MusicAdapter {
  players: MusicPlayer[] = [player];
  media: MusicMedia[] = [lofi];
  calls: string[] = [];
  acknowledgement: MusicCommandResult = { outcome: "accepted" };
  verified = true;
  listError: unknown = null;
  playError: unknown = null;

  async listPlayers(signal: AbortSignal): Promise<readonly MusicPlayer[]> {
    this.calls.push("players");
    if (signal.aborted) throw new MusicAdapterError("cancelled", "cancelled", false);
    if (this.listError) throw this.listError;
    return this.players;
  }
  async search(): Promise<readonly MusicMedia[]> {
    this.calls.push("search");
    return this.media;
  }
  async browse(): Promise<readonly MusicMedia[]> {
    return [];
  }
  async playerStatus(): Promise<MusicPlayerStatus> {
    this.calls.push("status");
    return {
      player: { ...player, state: this.verified ? "playing" : "idle" },
      queueId: player.id,
      nowPlaying: { media: this.verified ? lofi : null, positionSeconds: 0, durationSeconds: 120 },
    };
  }
  async queue(): Promise<MusicQueue> {
    this.calls.push("queue");
    return {
      id: player.id,
      name: "Living Room",
      state: this.verified ? "playing" : "idle",
      currentIndex: 0,
      positionSeconds: 0,
      durationSeconds: 120,
      items: this.verified ? [{ id: "q1", index: 1, media: lofi, available: true }] : [],
      truncated: false,
    };
  }
  async play(_playerId: string, _mediaUri: string, mode: MusicQueueMode): Promise<MusicCommandResult> {
    this.calls.push(`play:${mode}`);
    if (this.playError) throw this.playError;
    return this.acknowledgement;
  }
  async transport(
    _playerId: string,
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

const verification = { verificationAttempts: 1, verificationIntervalMs: 0, verificationWindowMs: 100 };

async function play(adapter: FakeMusicAdapter, queueMode: MusicQueueMode = "replace", signal?: AbortSignal) {
  return runMusicPlay(
    adapter,
    { request: "some lo-fi music", player: "Living Room", queueMode },
    signal ?? new AbortController().signal,
    verification,
  );
}

describe("composed music play state machine", () => {
  it("resolves, dispatches replace once, and reports only observed playback", async () => {
    const adapter = new FakeMusicAdapter();
    expect(await play(adapter)).toMatchObject({
      outcome: "playing",
      queueMode: "replace",
      player: { id: "living-1" },
      media: { id: "track-1" },
    });
    expect(adapter.calls).toEqual(["players", "search", "play:replace", "status"]);
  });

  it.each(["add", "play_next"] as const)("uses one atomic %s mutation and verifies the queue", async (mode) => {
    const adapter = new FakeMusicAdapter();
    expect(await play(adapter, mode)).toMatchObject({ outcome: "playing", queueMode: mode });
    expect(adapter.calls).toEqual(["players", "search", `play:${mode}`, "queue"]);
  });

  it("returns bounded ambiguity and performs no mutation", async () => {
    const rooms = new FakeMusicAdapter();
    rooms.players = [player, { ...player, id: "living-2" }];
    const roomResult = await play(rooms);
    expect(roomResult).toMatchObject({ outcome: "ambiguous_room" });
    expect(roomResult.candidates).toEqual([
      { id: "living-1", name: "Living Room" },
      { id: "living-2", name: "Living Room" },
    ]);
    expect(rooms.calls).toEqual(["players"]);

    const media = new FakeMusicAdapter();
    media.media = [lofi, { ...lofi, id: "track-2", uri: "library://track/2" }];
    const result = await play(media);
    expect(result.outcome).toBe("ambiguous_media");
    expect(result.candidates).toHaveLength(2);
    expect(media.calls).toEqual(["players", "search"]);
  });

  it("distinguishes no content, unavailable players, and adapter unavailability without mutation", async () => {
    const empty = new FakeMusicAdapter();
    empty.media = [];
    expect(await play(empty)).toMatchObject({ outcome: "not_found", player: { id: "living-1" } });

    const unavailablePlayer = new FakeMusicAdapter();
    unavailablePlayer.players = [{ ...player, available: false }];
    expect(await play(unavailablePlayer)).toMatchObject({ outcome: "no_available_player" });
    expect(unavailablePlayer.calls).toEqual(["players"]);

    const unavailableService = new FakeMusicAdapter();
    unavailableService.playError = new MusicAdapterError("unavailable", "down", false);
    expect(await play(unavailableService)).toMatchObject({ outcome: "unavailable" });
  });

  it("maps typed rejection and proven-undispatched failures to stable semantic outcomes", async () => {
    const rejected = new FakeMusicAdapter();
    rejected.playError = new MusicAdapterError("upstream", "no", false);
    expect(await play(rejected)).toMatchObject({ outcome: "rejected" });

    const failed = new FakeMusicAdapter();
    failed.playError = new MusicAdapterError("protocol", "bad", false);
    expect(await play(failed)).toMatchObject({ outcome: "failed" });

    const cancelled = new FakeMusicAdapter();
    cancelled.playError = new MusicAdapterError("cancelled", "cancelled before send", false);
    expect(await play(cancelled)).toMatchObject({ outcome: "rejected" });
    expect(cancelled.calls.filter((call) => call.startsWith("play:"))).toHaveLength(1);
  });

  it("never retries acknowledged but unverifiable or ambiguously dispatched playback", async () => {
    const unverified = new FakeMusicAdapter();
    unverified.verified = false;
    expect(await play(unverified)).toMatchObject({ outcome: "accepted_unverified" });
    expect(unverified.calls.filter((call) => call.startsWith("play:"))).toHaveLength(1);

    for (const kind of ["cancelled", "timeout"] as const) {
      const ambiguous = new FakeMusicAdapter();
      ambiguous.playError = new MusicAdapterError(kind, `${kind} after send`, true);
      expect(await play(ambiguous)).toMatchObject({ outcome: "accepted_unverified" });
      expect(ambiguous.calls.filter((call) => call.startsWith("play:"))).toHaveLength(1);
    }
  });

  it("does not treat cancellation during player resolution as a mutation", async () => {
    const adapter = new FakeMusicAdapter();
    adapter.listError = new MusicAdapterError("cancelled", "cancelled read", true);
    expect(await play(adapter)).toMatchObject({ outcome: "rejected" });
    expect(adapter.calls).toEqual(["players"]);
  });

  it("does nothing when cancelled before dispatch", async () => {
    const adapter = new FakeMusicAdapter();
    const controller = new AbortController();
    controller.abort();
    expect(await play(adapter, "replace", controller.signal)).toMatchObject({ outcome: "rejected" });
    expect(adapter.calls).toEqual([]);
  });
});
