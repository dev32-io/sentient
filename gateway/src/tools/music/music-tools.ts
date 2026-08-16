import type { ImpactTier } from "@sentient/protocol";
import type { NativeToolRunner } from "../tool-broker.js";
import type { ToolResult } from "../tool-types.js";
import {
  type MusicAdapter,
  MusicAdapterError,
  type MusicCommandResult,
  type MusicMediaType,
  type MusicPlayer,
  type MusicTransportAction,
} from "./music-adapter.js";
import { resolveMusicPlayer } from "./music-resolver.js";

const MAX_QUERY = 200;
const READ: ImpactTier = "read";
const WRITE: ImpactTier = "write";
const MEDIA_TYPES: readonly MusicMediaType[] = [
  "track",
  "album",
  "artist",
  "playlist",
  "radio",
  "podcast",
  "podcast_episode",
  "audiobook",
];
const TRANSPORT_ACTIONS: readonly MusicTransportAction[] = ["play", "pause", "stop", "next", "previous", "seek"];

export const MUSIC_TOOL_SETTINGS = [
  { name: "music_search", description: "Search Music Assistant's library and providers.", tier: READ },
  { name: "music_browse", description: "Browse Music Assistant providers and folders.", tier: READ },
  { name: "music_players", description: "List household music players and rooms.", tier: READ },
  { name: "music_status", description: "Inspect a music player and what is playing.", tier: READ },
  { name: "music_queue", description: "Inspect a music player's queue.", tier: READ },
  { name: "music_play", description: "Play selected media on a music player.", tier: WRITE },
  { name: "music_transport", description: "Control music playback transport.", tier: WRITE },
  { name: "music_volume", description: "Set a music player's volume.", tier: WRITE },
  { name: "music_transfer", description: "Transfer a music queue between players.", tier: WRITE },
  { name: "music_group", description: "Group or ungroup household music players.", tier: WRITE },
] as const;

function ok(value: unknown): ToolResult {
  return { content: JSON.stringify(value), isError: false };
}
function fail(message: string): ToolResult {
  return { content: JSON.stringify({ outcome: "error", message }), isError: true };
}
function argumentFailure(message: string): ToolResult {
  return fail(message);
}
function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function limitArg(args: Record<string, unknown>, fallback: number): number | null {
  const value = args.limit;
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 25 ? value : null;
}
function stringArrayArg(args: Record<string, unknown>, key: string): readonly string[] | null {
  const value = args[key];
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 25 &&
    value.every((item) => typeof item === "string" && item.trim())
    ? value.map((item) => (item as string).trim())
    : null;
}
function adapterFailure(error: unknown, mutating: boolean): ToolResult {
  if (error instanceof MusicAdapterError) {
    if (mutating && error.dispatched && (error.kind === "timeout" || error.kind === "unavailable")) {
      return ok({
        outcome: "accepted_unverified",
        reason: "The command may have been accepted, but completion could not be verified.",
      });
    }
    const messages: Record<MusicAdapterError["kind"], string> = {
      unavailable: "Music Assistant is unavailable.",
      authentication: "Music Assistant authentication failed.",
      timeout: "Music Assistant did not respond in time.",
      cancelled: "The music request was cancelled.",
      protocol: "Music Assistant returned an invalid response.",
      upstream: "Music Assistant rejected the request.",
      not_found: error.message,
    };
    return fail(messages[error.kind]);
  }
  return fail("The music operation failed.");
}

async function resolvedPlayer(
  adapter: MusicAdapter,
  query: string,
  signal: AbortSignal,
): Promise<{ player: MusicPlayer } | ToolResult> {
  const resolution = resolveMusicPlayer(await adapter.listPlayers(signal), query);
  if (resolution.kind === "resolved") return { player: resolution.player };
  if (resolution.kind === "not_found") return ok({ outcome: "not_found", player: query });
  return ok({ outcome: "ambiguous", player: query, matches: resolution.matches });
}
function isResult(value: object | ToolResult): value is ToolResult {
  return "content" in value;
}
async function resolveMany(
  adapter: MusicAdapter,
  queries: readonly string[],
  signal: AbortSignal,
): Promise<{ players: readonly MusicPlayer[] } | ToolResult> {
  const available = await adapter.listPlayers(signal);
  const players: MusicPlayer[] = [];
  for (const query of queries) {
    const resolution = resolveMusicPlayer(available, query);
    if (resolution.kind === "not_found") return ok({ outcome: "not_found", player: query });
    if (resolution.kind === "ambiguous")
      return ok({ outcome: "ambiguous", player: query, matches: resolution.matches });
    if (!players.some((player) => player.id === resolution.player.id)) players.push(resolution.player);
  }
  return { players };
}
function commandResult(result: MusicCommandResult, details: Record<string, unknown>): ToolResult {
  return ok({ outcome: result.outcome, ...details });
}

function runner(
  name: (typeof MUSIC_TOOL_SETTINGS)[number]["name"],
  description: string,
  tier: ImpactTier,
  parameters: Record<string, unknown>,
  validate: NativeToolRunner["validate"],
  run: NativeToolRunner["run"],
): NativeToolRunner {
  return {
    definition: {
      name,
      description,
      parameters,
      category: "foreground",
      tier,
      productGroup: "music",
      defaultExposure: "standard",
    },
    ...(validate ? { validate } : {}),
    run,
  };
}

export function createMusicTools(adapter: MusicAdapter): readonly NativeToolRunner[] {
  return [
    runner(
      "music_search",
      "Search Music Assistant. Returns bounded stable media IDs suitable for music_play.",
      READ,
      {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          media_types: { type: "array", items: { enum: MEDIA_TYPES } },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
      },
      (args) => {
        const query = stringArg(args, "query");
        if (!query || query.length > MAX_QUERY)
          return argumentFailure(`music_search requires a non-empty query of at most ${MAX_QUERY} characters.`);
        if (limitArg(args, 10) === null) return argumentFailure("limit must be an integer from 1 to 25.");
        const types = args.media_types;
        if (
          types !== undefined &&
          (!Array.isArray(types) || types.some((type) => !MEDIA_TYPES.includes(type as MusicMediaType)))
        )
          return argumentFailure("media_types contains an unsupported media type.");
        return null;
      },
      async (args, { signal }) => {
        try {
          const query = stringArg(args, "query");
          const limit = limitArg(args, 10);
          if (!query || limit === null) return argumentFailure("Invalid music search arguments.");
          const rawTypes = args.media_types;
          const mediaTypes = Array.isArray(rawTypes) ? (rawTypes as MusicMediaType[]) : undefined;
          const items = await adapter.search(query, { ...(mediaTypes ? { mediaTypes } : {}), limit }, signal);
          return ok({ outcome: "ok", items, count: items.length });
        } catch (error) {
          return adapterFailure(error, false);
        }
      },
    ),
    runner(
      "music_browse",
      "Browse Music Assistant's root or a stable folder path returned by a previous browse.",
      READ,
      {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 25 } },
      },
      (args) => {
        if (args.path !== undefined && typeof args.path !== "string")
          return argumentFailure("path must be a string when provided.");
        if (limitArg(args, 10) === null) return argumentFailure("limit must be an integer from 1 to 25.");
        return null;
      },
      async (args, { signal }) => {
        try {
          const limit = limitArg(args, 10);
          if (limit === null) return argumentFailure("Invalid browse limit.");
          const items = await adapter.browse(
            typeof args.path === "string" && args.path ? args.path : null,
            limit,
            signal,
          );
          return ok({ outcome: "ok", items, count: items.length });
        } catch (error) {
          return adapterFailure(error, false);
        }
      },
    ),
    runner(
      "music_players",
      "List Music Assistant players/rooms with stable IDs and bounded playback state.",
      READ,
      { type: "object", additionalProperties: false, properties: {} },
      () => null,
      async (_args, { signal }) => {
        try {
          const players = await adapter.listPlayers(signal);
          return ok({ outcome: "ok", players, count: players.length });
        } catch (error) {
          return adapterFailure(error, false);
        }
      },
    ),
    runner(
      "music_status",
      "Inspect a player/room and its current media. Names are resolved without guessing.",
      READ,
      { type: "object", additionalProperties: false, required: ["player"], properties: { player: { type: "string" } } },
      (args) => (stringArg(args, "player") ? null : argumentFailure("music_status requires a player name or ID.")),
      async (args, { signal }) => {
        try {
          const query = stringArg(args, "player");
          if (!query) return argumentFailure("Missing player.");
          const selected = await resolvedPlayer(adapter, query, signal);
          if (isResult(selected)) return selected;
          return ok({ outcome: "ok", status: await adapter.playerStatus(selected.player.id, signal) });
        } catch (error) {
          return adapterFailure(error, false);
        }
      },
    ),
    runner(
      "music_queue",
      "Inspect a player's bounded current queue. Names are resolved without guessing.",
      READ,
      {
        type: "object",
        additionalProperties: false,
        required: ["player"],
        properties: { player: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 25 } },
      },
      (args) =>
        !stringArg(args, "player")
          ? argumentFailure("music_queue requires a player name or ID.")
          : limitArg(args, 20) === null
            ? argumentFailure("limit must be an integer from 1 to 25.")
            : null,
      async (args, { signal }) => {
        try {
          const query = stringArg(args, "player");
          const limit = limitArg(args, 20);
          if (!query || limit === null) return argumentFailure("Invalid queue arguments.");
          const selected = await resolvedPlayer(adapter, query, signal);
          if (isResult(selected)) return selected;
          return ok({ outcome: "ok", queue: await adapter.queue(selected.player.id, limit, signal) });
        } catch (error) {
          return adapterFailure(error, false);
        }
      },
    ),
    runner(
      "music_play",
      "Directly play a stable media ID returned by music_search or music_browse on a selected player.",
      WRITE,
      {
        type: "object",
        additionalProperties: false,
        required: ["player", "media_id"],
        properties: { player: { type: "string" }, media_id: { type: "string" } },
      },
      (args) =>
        !stringArg(args, "player") || !stringArg(args, "media_id")
          ? argumentFailure("music_play requires player and media_id strings.")
          : null,
      async (args, { signal }) => {
        try {
          const query = stringArg(args, "player");
          const mediaId = stringArg(args, "media_id");
          if (!query || !mediaId) return argumentFailure("Invalid play arguments.");
          const selected = await resolvedPlayer(adapter, query, signal);
          if (isResult(selected)) return selected;
          return commandResult(await adapter.play(selected.player.id, mediaId, signal), {
            player: { id: selected.player.id, name: selected.player.name },
            media_id: mediaId,
          });
        } catch (error) {
          return adapterFailure(error, true);
        }
      },
    ),
    runner(
      "music_transport",
      "Play, pause, stop, skip, or seek a selected Music Assistant player.",
      WRITE,
      {
        type: "object",
        additionalProperties: false,
        required: ["player", "action"],
        properties: {
          player: { type: "string" },
          action: { enum: TRANSPORT_ACTIONS },
          position_seconds: { type: "integer", minimum: 0 },
        },
      },
      (args) => {
        if (!stringArg(args, "player") || !TRANSPORT_ACTIONS.includes(args.action as MusicTransportAction))
          return argumentFailure("music_transport requires a player and supported action.");
        if (
          args.action === "seek" &&
          (typeof args.position_seconds !== "number" ||
            !Number.isInteger(args.position_seconds) ||
            args.position_seconds < 0)
        )
          return argumentFailure("seek requires a non-negative integer position_seconds.");
        return null;
      },
      async (args, { signal }) => {
        try {
          const query = stringArg(args, "player");
          const action = args.action as MusicTransportAction;
          if (!query || !TRANSPORT_ACTIONS.includes(action)) return argumentFailure("Invalid transport arguments.");
          const selected = await resolvedPlayer(adapter, query, signal);
          if (isResult(selected)) return selected;
          const position =
            action === "seek" && typeof args.position_seconds === "number" ? args.position_seconds : null;
          return commandResult(await adapter.transport(selected.player.id, action, position, signal), {
            player: { id: selected.player.id, name: selected.player.name },
            action,
          });
        } catch (error) {
          return adapterFailure(error, true);
        }
      },
    ),
    runner(
      "music_volume",
      "Set volume from 0 to 100 on a selected Music Assistant player.",
      WRITE,
      {
        type: "object",
        additionalProperties: false,
        required: ["player", "volume"],
        properties: { player: { type: "string" }, volume: { type: "integer", minimum: 0, maximum: 100 } },
      },
      (args) =>
        !stringArg(args, "player") ||
        typeof args.volume !== "number" ||
        !Number.isInteger(args.volume) ||
        args.volume < 0 ||
        args.volume > 100
          ? argumentFailure("music_volume requires a player and integer volume from 0 to 100.")
          : null,
      async (args, { signal }) => {
        try {
          const query = stringArg(args, "player");
          if (!query || typeof args.volume !== "number") return argumentFailure("Invalid volume arguments.");
          const selected = await resolvedPlayer(adapter, query, signal);
          if (isResult(selected)) return selected;
          return commandResult(await adapter.setVolume(selected.player.id, args.volume, signal), {
            player: { id: selected.player.id, name: selected.player.name },
            volume: args.volume,
          });
        } catch (error) {
          return adapterFailure(error, true);
        }
      },
    ),
    runner(
      "music_transfer",
      "Transfer the current queue from one selected player to another.",
      WRITE,
      {
        type: "object",
        additionalProperties: false,
        required: ["source_player", "target_player"],
        properties: {
          source_player: { type: "string" },
          target_player: { type: "string" },
          auto_play: { type: "boolean", default: true },
        },
      },
      (args) =>
        !stringArg(args, "source_player") ||
        !stringArg(args, "target_player") ||
        (args.auto_play !== undefined && typeof args.auto_play !== "boolean")
          ? argumentFailure(
              "music_transfer requires source_player and target_player strings and optional boolean auto_play.",
            )
          : null,
      async (args, { signal }) => {
        try {
          const source = stringArg(args, "source_player");
          const target = stringArg(args, "target_player");
          if (!source || !target) return argumentFailure("Invalid transfer arguments.");
          const selected = await resolveMany(adapter, [source, target], signal);
          if (isResult(selected)) return selected;
          if (selected.players.length !== 2) return argumentFailure("Source and target players must be different.");
          const [from, to] = selected.players as [MusicPlayer, MusicPlayer];
          return commandResult(await adapter.transfer(from.id, to.id, args.auto_play !== false, signal), {
            source: { id: from.id, name: from.name },
            target: { id: to.id, name: to.name },
          });
        } catch (error) {
          return adapterFailure(error, true);
        }
      },
    ),
    runner(
      "music_group",
      "Join players to a group leader, or remove players from their current groups.",
      WRITE,
      {
        type: "object",
        additionalProperties: false,
        required: ["action", "players"],
        properties: {
          action: { enum: ["join", "leave"] },
          target_player: { type: "string" },
          players: { type: "array", minItems: 1, maxItems: 25, items: { type: "string" } },
        },
      },
      (args) => {
        if (args.action !== "join" && args.action !== "leave")
          return argumentFailure("music_group action must be join or leave.");
        if (!stringArrayArg(args, "players"))
          return argumentFailure("music_group requires one or more player names or IDs.");
        if (args.action === "join" && !stringArg(args, "target_player"))
          return argumentFailure("Joining requires target_player.");
        return null;
      },
      async (args, { signal }) => {
        try {
          const players = stringArrayArg(args, "players");
          if (!players || (args.action !== "join" && args.action !== "leave"))
            return argumentFailure("Invalid grouping arguments.");
          if (args.action === "leave") {
            const selected = await resolveMany(adapter, players, signal);
            if (isResult(selected)) return selected;
            return commandResult(
              await adapter.ungroup(
                selected.players.map((player) => player.id),
                signal,
              ),
              { action: "leave", players: selected.players.map(({ id, name }) => ({ id, name })) },
            );
          }
          const target = stringArg(args, "target_player");
          if (!target) return argumentFailure("Joining requires target_player.");
          const selected = await resolveMany(adapter, [target, ...players], signal);
          if (isResult(selected)) return selected;
          const [leader, ...members] = selected.players;
          if (!leader || members.length === 0)
            return argumentFailure("Group members must differ from the target player.");
          return commandResult(
            await adapter.group(
              leader.id,
              members.map((player) => player.id),
              signal,
            ),
            {
              action: "join",
              target: { id: leader.id, name: leader.name },
              players: members.map(({ id, name }) => ({ id, name })),
            },
          );
        } catch (error) {
          return adapterFailure(error, true);
        }
      },
    ),
  ];
}
