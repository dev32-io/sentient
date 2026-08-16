import { z } from "zod";

const MAX_RESULTS = 25;
const MAX_TEXT = 256;

export type MusicMediaType =
  | "track"
  | "album"
  | "artist"
  | "playlist"
  | "radio"
  | "podcast"
  | "podcast_episode"
  | "audiobook"
  | "folder"
  | "unknown";
export type PlaybackState = "playing" | "paused" | "idle" | "unavailable" | "unknown";

export interface MusicMedia {
  readonly id: string;
  readonly uri: string;
  readonly type: MusicMediaType;
  readonly name: string;
  readonly provider: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly available: boolean;
  readonly browsable: boolean;
}

export interface MusicPlayer {
  readonly id: string;
  readonly name: string;
  /** Optional household aliases supplied by the adapter, always bounded. */
  readonly aliases?: readonly string[];
  readonly available: boolean;
  readonly powered: boolean;
  readonly state: PlaybackState;
  readonly volume: number | null;
  readonly muted: boolean | null;
  readonly groupMemberIds: readonly string[];
  readonly activeSource: string | null;
}

export interface NowPlaying {
  readonly media: MusicMedia | null;
  readonly positionSeconds: number | null;
  readonly durationSeconds: number | null;
}

export interface MusicPlayerStatus {
  readonly player: MusicPlayer;
  readonly queueId: string | null;
  readonly nowPlaying: NowPlaying;
}

export interface MusicQueueItem {
  readonly id: string;
  readonly index: number | null;
  readonly media: MusicMedia | null;
  readonly available: boolean;
}

export interface MusicQueue {
  readonly id: string;
  readonly name: string;
  readonly state: PlaybackState;
  readonly currentIndex: number | null;
  readonly positionSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly items: readonly MusicQueueItem[];
  readonly truncated: boolean;
}

export type MusicCommandOutcome = "completed" | "accepted" | "accepted_unverified";
export interface MusicCommandResult {
  readonly outcome: MusicCommandOutcome;
}

/** Queue behavior understood by Music Assistant's atomic play_media command. */
export type MusicQueueMode = "replace" | "add" | "play_next";

export type MusicTransportAction = "play" | "pause" | "stop" | "next" | "previous" | "seek";

export interface MusicAdapter {
  search(
    query: string,
    options: { mediaTypes?: readonly MusicMediaType[]; limit?: number },
    signal: AbortSignal,
  ): Promise<readonly MusicMedia[]>;
  browse(path: string | null, limit: number, signal: AbortSignal): Promise<readonly MusicMedia[]>;
  listPlayers(signal: AbortSignal): Promise<readonly MusicPlayer[]>;
  playerStatus(playerId: string, signal: AbortSignal): Promise<MusicPlayerStatus>;
  queue(playerId: string, limit: number, signal: AbortSignal): Promise<MusicQueue>;
  play(playerId: string, mediaUri: string, queueMode: MusicQueueMode, signal: AbortSignal): Promise<MusicCommandResult>;
  transport(
    playerId: string,
    action: MusicTransportAction,
    positionSeconds: number | null,
    signal: AbortSignal,
  ): Promise<MusicCommandResult>;
  setVolume(playerId: string, volume: number, signal: AbortSignal): Promise<MusicCommandResult>;
  transfer(
    sourcePlayerId: string,
    targetPlayerId: string,
    autoPlay: boolean,
    signal: AbortSignal,
  ): Promise<MusicCommandResult>;
  group(targetPlayerId: string, memberPlayerIds: readonly string[], signal: AbortSignal): Promise<MusicCommandResult>;
  ungroup(playerIds: readonly string[], signal: AbortSignal): Promise<MusicCommandResult>;
}

export type MusicAdapterErrorKind =
  | "unavailable"
  | "authentication"
  | "timeout"
  | "cancelled"
  | "protocol"
  | "upstream"
  | "not_found";
export class MusicAdapterError extends Error {
  constructor(
    readonly kind: MusicAdapterErrorKind,
    message: string,
    readonly dispatched = false,
  ) {
    super(message);
    this.name = "MusicAdapterError";
  }
}

interface SocketEvent {
  readonly data?: unknown;
}
interface CloseEventLike {
  readonly code?: number;
}
export interface MusicWebSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: SocketEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: CloseEventLike) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type MusicWebSocketFactory = (url: string) => MusicWebSocket;

export interface NativeMusicAdapterOptions {
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly reconnectAttempts?: number;
  readonly websocketFactory?: MusicWebSocketFactory;
}

const responseSchema = z.union([
  z.object({ message_id: z.string(), result: z.unknown() }).passthrough(),
  z
    .object({
      message_id: z.string(),
      error_code: z.number(),
      details: z.string().optional(),
    })
    .passthrough(),
]);

interface PendingRequest {
  readonly generation: number;
  dispatched: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: MusicAdapterError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : fallback;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function boundedInt(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(MAX_RESULTS, Math.trunc(value ?? fallback)));
}
function playbackState(value: unknown, available = true): PlaybackState {
  if (!available) return "unavailable";
  const state = text(value).toLowerCase();
  return state === "playing" || state === "paused" || state === "idle" ? state : "unknown";
}
function mediaType(value: unknown): MusicMediaType {
  const normalized = text(value).toLowerCase();
  const allowed: readonly MusicMediaType[] = [
    "track",
    "album",
    "artist",
    "playlist",
    "radio",
    "podcast",
    "podcast_episode",
    "audiobook",
    "folder",
  ];
  return allowed.includes(normalized as MusicMediaType) ? (normalized as MusicMediaType) : "unknown";
}
function firstName(value: unknown): string | null {
  if (typeof value === "string") return text(value) || null;
  const obj = object(value);
  if (obj) return text(obj.name) || null;
  if (Array.isArray(value)) return firstName(value[0]);
  return null;
}

export function normalizeMedia(value: unknown): MusicMedia | null {
  const raw = object(value);
  if (!raw) return null;
  const type = mediaType(raw.media_type ?? raw.type);
  const provider = text(raw.provider ?? raw.provider_instance ?? raw.provider_domain) || null;
  const itemId = text(raw.item_id ?? raw.id);
  const uri = text(raw.uri) || (provider && itemId && type !== "unknown" ? `${provider}://${type}/${itemId}` : "");
  const name = text(raw.name ?? raw.title);
  if (!uri || !name) return null;
  const album = firstName(raw.album);
  const artist = firstName(raw.artists) ?? firstName(raw.artist);
  return {
    id: uri,
    uri,
    type,
    name,
    provider,
    artist,
    album,
    available: bool(raw.available, true),
    browsable: type === "folder" || bool(raw.is_browsable, false),
  };
}

export function normalizePlayer(value: unknown): MusicPlayer | null {
  const raw = object(value);
  if (!raw) return null;
  const id = text(raw.player_id ?? raw.id);
  const name = text(raw.name ?? raw.display_name);
  if (!id || !name) return null;
  const available = bool(raw.available, true);
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
        .map((value) => text(value))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  const members = Array.isArray(raw.group_members)
    ? raw.group_members
        .map((v) => text(v))
        .filter(Boolean)
        .slice(0, MAX_RESULTS)
    : [];
  return {
    id,
    name,
    aliases,
    available,
    powered: bool(raw.powered, available),
    state: playbackState(raw.playback_state ?? raw.state, available),
    volume: finite(raw.volume_level),
    muted: typeof raw.volume_muted === "boolean" ? raw.volume_muted : null,
    groupMemberIds: members,
    activeSource: text(raw.active_source) || null,
  };
}

function normalizeQueueItem(value: unknown, fallbackIndex: number): MusicQueueItem | null {
  const raw = object(value);
  if (!raw) return null;
  const media = normalizeMedia(raw.media_item ?? raw.media ?? raw);
  const id = text(raw.queue_item_id ?? raw.item_id ?? raw.id) || media?.id || "";
  if (!id) return null;
  return {
    id,
    index: finite(raw.index) ?? fallbackIndex,
    media,
    available: bool(raw.available, media?.available ?? true),
  };
}

const SEARCH_COLLECTION_KEYS = [
  "tracks",
  "albums",
  "artists",
  "playlists",
  "radio",
  "podcasts",
  "podcast_episodes",
  "audiobooks",
] as const;

function searchCollection(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const raw = object(value);
  if (!raw) return null;
  const present = SEARCH_COLLECTION_KEYS.filter((key) => Object.hasOwn(raw, key));
  if (present.length === 0 || present.some((key) => !Array.isArray(raw[key]))) return null;
  return present.flatMap((key) => raw[key] as unknown[]);
}

function normalizeCollection<T>(
  value: unknown,
  normalize: (item: unknown, index: number) => T | null,
  message: string,
): T[] {
  if (!Array.isArray(value)) throw new MusicAdapterError("protocol", message, true);
  const normalized = value.map(normalize);
  if (normalized.some((item) => item === null)) throw new MusicAdapterError("protocol", message, true);
  return normalized as T[];
}

function abortError(dispatched = false): MusicAdapterError {
  return new MusicAdapterError("cancelled", "music request cancelled", dispatched);
}
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class NativeMusicAdapter implements MusicAdapter {
  private socket: MusicWebSocket | null = null;
  private connecting: Promise<MusicWebSocket> | null = null;
  private generation = 0;
  private sequence = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectAttempts: number;
  private readonly factory: MusicWebSocketFactory;
  private readonly wsUrl: string;

  constructor(
    private readonly url: string,
    private readonly token: string,
    options: NativeMusicAdapterOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.reconnectAttempts = Math.max(0, Math.min(3, options.reconnectAttempts ?? 1));
    this.factory = options.websocketFactory ?? ((target) => new WebSocket(target) as unknown as MusicWebSocket);
    this.wsUrl = this.toWebSocketUrl(url);
  }

  private toWebSocketUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new MusicAdapterError("unavailable", "Music Assistant URL is invalid");
    }
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    const pathname = parsed.pathname.replace(/\/$/, "");
    parsed.pathname = pathname.endsWith("/ws") ? pathname : `${pathname}/ws`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  private nextId(generation: number): string {
    return `sentient-${generation}-${++this.sequence}`;
  }

  private connect(): Promise<MusicWebSocket> {
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    this.connecting = new Promise<MusicWebSocket>((resolve, reject) => {
      let socket: MusicWebSocket;
      try {
        socket = this.factory(this.wsUrl);
      } catch {
        reject(new MusicAdapterError("unavailable", "Music Assistant connection failed"));
        return;
      }
      this.socket = socket;
      let settled = false;
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close(1000, "connect timeout");
        reject(new MusicAdapterError("timeout", "Music Assistant connection timed out"));
      }, this.connectTimeoutMs);
      const failConnect = (error: MusicAdapterError) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(error);
      };
      socket.onmessage = (event) => this.handleMessage(socket, generation, event.data);
      socket.onerror = () => failConnect(new MusicAdapterError("unavailable", "Music Assistant connection failed"));
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        for (const [id, pending] of this.pending) {
          if (pending.generation !== generation) continue;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(new MusicAdapterError("unavailable", "Music Assistant connection closed", pending.dispatched));
        }
        failConnect(new MusicAdapterError("unavailable", "Music Assistant connection closed"));
      };
      socket.onopen = () => {
        const authId = this.nextId(generation);
        const timer = setTimeout(() => {
          this.pending.delete(authId);
          failConnect(new MusicAdapterError("authentication", "Music Assistant authentication timed out"));
          socket.close(1000, "authentication timeout");
        }, this.connectTimeoutMs);
        this.pending.set(authId, {
          generation,
          dispatched: true,
          timer,
          resolve: (result) => {
            const auth = object(result);
            if (!auth || auth.authenticated !== true) {
              failConnect(new MusicAdapterError("authentication", "Music Assistant authentication failed", true));
              socket.close(1000, "authentication failed");
              return;
            }
            if (settled || this.socket !== socket) return;
            settled = true;
            clearTimeout(connectTimer);
            resolve(socket);
          },
          reject: () => {
            failConnect(new MusicAdapterError("authentication", "Music Assistant authentication failed", true));
            socket.close(1000, "authentication failed");
          },
        });
        try {
          socket.send(
            JSON.stringify({
              message_id: authId,
              command: "auth",
              args: { token: this.token },
            }),
          );
        } catch {
          this.pending.delete(authId);
          clearTimeout(timer);
          failConnect(new MusicAdapterError("unavailable", "Music Assistant authentication could not be sent"));
        }
      };
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private handleMessage(socket: MusicWebSocket, generation: number, data: unknown): void {
    if (this.socket !== socket || this.generation !== generation) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(typeof data === "string" ? data : "");
    } catch {
      return;
    }
    const candidate = object(decoded);
    if (!candidate || typeof candidate.message_id !== "string") return; // events and malformed noise
    const pending = this.pending.get(candidate.message_id);
    if (!pending || pending.generation !== generation) return;
    const hasResult = Object.hasOwn(candidate, "result");
    const hasError = Object.hasOwn(candidate, "error_code");
    const parsed = responseSchema.safeParse(decoded);
    if (!parsed.success || hasResult === hasError) {
      clearTimeout(pending.timer);
      this.pending.delete(candidate.message_id);
      pending.reject(new MusicAdapterError("protocol", "Music Assistant returned a malformed response", true));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(parsed.data.message_id);
    if ("error_code" in parsed.data) {
      const kind = parsed.data.error_code === 1 || parsed.data.error_code === 401 ? "authentication" : "upstream";
      pending.reject(
        new MusicAdapterError(
          kind,
          parsed.data.details ? text(parsed.data.details) : "Music Assistant rejected the request",
          true,
        ),
      );
    } else pending.resolve(parsed.data.result);
  }

  private async request(
    command: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    mutating: boolean,
  ): Promise<unknown | MusicCommandResult> {
    if (!this.url || !this.token) throw new MusicAdapterError("unavailable", "Music Assistant is not configured");
    for (let attempt = 0; attempt <= this.reconnectAttempts; attempt++) {
      if (signal.aborted) throw abortError();
      let socket: MusicWebSocket;
      try {
        socket = await raceAbort(this.connect(), signal);
      } catch (error) {
        const typed =
          error instanceof MusicAdapterError
            ? error
            : new MusicAdapterError("unavailable", "Music Assistant connection failed");
        if (!typed.dispatched && typed.kind !== "cancelled" && attempt < this.reconnectAttempts) continue;
        throw typed;
      }
      const generation = this.generation;
      const id = this.nextId(generation);
      try {
        return await new Promise<unknown>((resolve, reject) => {
          if (signal.aborted) {
            reject(abortError());
            return;
          }
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new MusicAdapterError("timeout", "Music Assistant request timed out", true));
          }, this.requestTimeoutMs);
          const pending: PendingRequest = {
            generation,
            dispatched: false,
            timer,
            resolve: (value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            },
            reject: (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          };
          const abort = () => {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(abortError(pending.dispatched));
          };
          signal.addEventListener("abort", abort, { once: true });
          this.pending.set(id, pending);
          try {
            // Mark possible dispatch before calling send so synchronous cancellation
            // from the transport cannot make an enqueued command look retry-safe.
            pending.dispatched = true;
            socket.send(JSON.stringify({ message_id: id, command, args }));
          } catch {
            signal.removeEventListener("abort", abort);
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new MusicAdapterError("unavailable", "Music Assistant request could not be sent", false));
          }
        });
      } catch (error) {
        const typed =
          error instanceof MusicAdapterError
            ? error
            : new MusicAdapterError("unavailable", "Music Assistant request failed");
        if (
          mutating &&
          typed.dispatched &&
          (typed.kind === "timeout" ||
            typed.kind === "cancelled" ||
            typed.kind === "unavailable" ||
            typed.kind === "protocol")
        )
          return { outcome: "accepted_unverified" };
        if (!typed.dispatched && typed.kind !== "cancelled" && attempt < this.reconnectAttempts) continue;
        throw typed;
      }
    }
    throw new MusicAdapterError("unavailable", "Music Assistant is unavailable");
  }

  private async mutation(
    command: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MusicCommandResult> {
    const result = await this.request(command, args, signal, true);
    if (object(result)?.outcome === "accepted_unverified") return result as MusicCommandResult;
    // MA's success response proves only handler acknowledgement. Composed
    // callers must still observe player/queue state before claiming playback.
    return { outcome: "accepted" };
  }

  async search(
    query: string,
    options: { mediaTypes?: readonly MusicMediaType[]; limit?: number },
    signal: AbortSignal,
  ): Promise<readonly MusicMedia[]> {
    const limit = boundedInt(options.limit, 10);
    const result = await this.request(
      "music/search",
      {
        search_query: query,
        limit,
        library_only: false,
        ...(options.mediaTypes ? { media_types: options.mediaTypes } : {}),
      },
      signal,
      false,
    );
    const items = searchCollection(result);
    if (!items) throw new MusicAdapterError("protocol", "Music Assistant returned malformed search results", true);
    return normalizeCollection(items, normalizeMedia, "Music Assistant returned malformed search results").slice(
      0,
      limit,
    );
  }
  async browse(path: string | null, limit: number, signal: AbortSignal): Promise<readonly MusicMedia[]> {
    const bounded = boundedInt(limit, 10);
    const result = await this.request("music/browse", path ? { path } : {}, signal, false);
    return normalizeCollection(result, normalizeMedia, "Music Assistant returned malformed browse results").slice(
      0,
      bounded,
    );
  }
  async listPlayers(signal: AbortSignal): Promise<readonly MusicPlayer[]> {
    const result = await this.request("players/all", { return_unavailable: true }, signal, false);
    return normalizeCollection(result, normalizePlayer, "Music Assistant returned malformed player results").slice(
      0,
      MAX_RESULTS,
    );
  }
  async playerStatus(playerId: string, signal: AbortSignal): Promise<MusicPlayerStatus> {
    const [playerRaw, queueRaw] = await Promise.all([
      this.request("players/get", { player_id: playerId }, signal, false),
      this.request("player_queues/get_active_queue", { player_id: playerId }, signal, false),
    ]);
    const player = normalizePlayer(playerRaw);
    if (!player) throw new MusicAdapterError("not_found", "Music Assistant player was not found");
    const queue = object(queueRaw);
    const current = queue ? object(queue.current_item) : null;
    return {
      player,
      queueId: queue ? text(queue.queue_id ?? queue.id) || null : null,
      nowPlaying: {
        media: normalizeMedia(current?.media_item ?? current ?? object(playerRaw)?.current_media),
        positionSeconds: finite(queue?.elapsed_time ?? object(playerRaw)?.elapsed_time),
        durationSeconds: finite(queue?.duration ?? current?.duration),
      },
    };
  }
  async queue(playerId: string, limit: number, signal: AbortSignal): Promise<MusicQueue> {
    const bounded = boundedInt(limit, 20);
    const queueRaw = await this.request("player_queues/get_active_queue", { player_id: playerId }, signal, false);
    const queue = object(queueRaw);
    if (!queue) throw new MusicAdapterError("not_found", "No active Music Assistant queue was found for that player");
    const id = text(queue.queue_id ?? queue.id);
    if (!id) throw new MusicAdapterError("protocol", "Music Assistant returned a queue without an identity", true);
    const itemsRaw = await this.request(
      "player_queues/items",
      { queue_id: id, limit: bounded + 1, offset: 0 },
      signal,
      false,
    );
    const allItems = normalizeCollection(
      itemsRaw,
      normalizeQueueItem,
      "Music Assistant returned malformed queue items",
    );
    return {
      id,
      name: text(queue.display_name ?? queue.name, "Queue"),
      state: playbackState(queue.state),
      currentIndex: finite(queue.current_index),
      positionSeconds: finite(queue.elapsed_time),
      durationSeconds: finite(queue.duration ?? object(queue.current_item)?.duration),
      items: allItems.slice(0, bounded),
      truncated: allItems.length > bounded,
    };
  }
  play(
    playerId: string,
    mediaUri: string,
    queueMode: MusicQueueMode,
    signal: AbortSignal,
  ): Promise<MusicCommandResult> {
    const option = queueMode === "play_next" ? "next" : queueMode;
    return this.mutation("player_queues/play_media", { queue_id: playerId, media: [mediaUri], option }, signal);
  }
  transport(
    playerId: string,
    action: MusicTransportAction,
    positionSeconds: number | null,
    signal: AbortSignal,
  ): Promise<MusicCommandResult> {
    return this.mutation(
      `player_queues/${action}`,
      {
        queue_id: playerId,
        ...(action === "seek" ? { position: positionSeconds } : {}),
      },
      signal,
    );
  }
  setVolume(playerId: string, volume: number, signal: AbortSignal): Promise<MusicCommandResult> {
    return this.mutation("players/cmd/volume_set", { player_id: playerId, volume_level: volume }, signal);
  }
  transfer(
    sourcePlayerId: string,
    targetPlayerId: string,
    autoPlay: boolean,
    signal: AbortSignal,
  ): Promise<MusicCommandResult> {
    return this.mutation(
      "player_queues/transfer",
      {
        source_queue_id: sourcePlayerId,
        target_queue_id: targetPlayerId,
        auto_play: autoPlay,
      },
      signal,
    );
  }
  async group(
    targetPlayerId: string,
    memberPlayerIds: readonly string[],
    signal: AbortSignal,
  ): Promise<MusicCommandResult> {
    const outcome: MusicCommandResult = { outcome: "accepted" };
    for (const playerId of memberPlayerIds) {
      const result = await this.mutation(
        "players/cmd/group",
        { player_id: playerId, target_player: targetPlayerId },
        signal,
      );
      if (result.outcome === "accepted_unverified") return result;
    }
    return outcome;
  }
  async ungroup(playerIds: readonly string[], signal: AbortSignal): Promise<MusicCommandResult> {
    const outcome: MusicCommandResult = { outcome: "accepted" };
    for (const playerId of playerIds) {
      const result = await this.mutation("players/cmd/ungroup", { player_id: playerId }, signal);
      if (result.outcome === "accepted_unverified") return result;
    }
    return outcome;
  }
}

export class UnavailableMusicAdapter implements MusicAdapter {
  private unavailable(): never {
    throw new MusicAdapterError("unavailable", "Music Assistant is not configured");
  }
  search(): Promise<readonly MusicMedia[]> {
    return this.unavailable();
  }
  browse(): Promise<readonly MusicMedia[]> {
    return this.unavailable();
  }
  listPlayers(): Promise<readonly MusicPlayer[]> {
    return this.unavailable();
  }
  playerStatus(): Promise<MusicPlayerStatus> {
    return this.unavailable();
  }
  queue(): Promise<MusicQueue> {
    return this.unavailable();
  }
  play(): Promise<MusicCommandResult> {
    return this.unavailable();
  }
  transport(): Promise<MusicCommandResult> {
    return this.unavailable();
  }
  setVolume(): Promise<MusicCommandResult> {
    return this.unavailable();
  }
  transfer(): Promise<MusicCommandResult> {
    return this.unavailable();
  }
  group(): Promise<MusicCommandResult> {
    return this.unavailable();
  }
  ungroup(): Promise<MusicCommandResult> {
    return this.unavailable();
  }
}
