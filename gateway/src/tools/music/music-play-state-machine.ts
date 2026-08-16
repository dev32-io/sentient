import {
  type MusicAdapter,
  MusicAdapterError,
  type MusicMedia,
  type MusicPlayer,
  type MusicQueue,
  type MusicQueueMode,
} from "./music-adapter.js";
import { resolveMusicPlayer } from "./music-resolver.js";

const SEARCH_LIMIT = 10;
const CANDIDATE_LIMIT = 5;
const STOP_WORDS = new Set(["a", "an", "some", "the", "music", "please", "play", "listen", "to"]);

export interface MusicPlayRequest {
  readonly request: string;
  readonly player: string;
  readonly queueMode: MusicQueueMode;
}

export type MusicPlayOutcome =
  | "playing"
  | "not_found"
  | "ambiguous_room"
  | "ambiguous_media"
  | "no_available_player"
  | "rejected"
  | "failed"
  | "unavailable"
  | "accepted_unverified";

interface Selection {
  readonly player?: Pick<MusicPlayer, "id" | "name">;
  readonly media?: Pick<MusicMedia, "id" | "uri" | "type" | "name">;
}

export interface MusicPlayResult extends Selection {
  readonly outcome: MusicPlayOutcome;
  readonly queueMode: MusicQueueMode;
  readonly candidates?: readonly Record<string, unknown>[];
  readonly reason?: string;
}

export interface MusicPlayMachineOptions {
  readonly verificationAttempts?: number;
  readonly verificationIntervalMs?: number;
  readonly verificationWindowMs?: number;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function meaningful(value: string): string {
  return normalize(value)
    .split(" ")
    .filter((token) => !STOP_WORDS.has(token))
    .join(" ");
}

function mediaScore(media: MusicMedia, request: string): number {
  const query = meaningful(request);
  if (!query) return 0;
  const fields = [media.name, media.artist ?? "", media.album ?? ""].map(normalize);
  if (fields[0] === query) return 1;
  if (fields.some((field) => field === query)) return 0.95;
  if (fields[0]?.startsWith(`${query} `) || fields[0]?.includes(` ${query} `)) return 0.9;
  const queryTokens = new Set(query.split(" "));
  const fieldTokens = new Set(fields.join(" ").split(" ").filter(Boolean));
  let overlap = 0;
  for (const token of queryTokens) if (fieldTokens.has(token)) overlap += 1;
  return overlap / queryTokens.size;
}

function mediaCandidate(media: MusicMedia): Record<string, unknown> {
  return {
    id: media.id,
    uri: media.uri,
    type: media.type,
    name: media.name,
    ...(media.artist ? { artist: media.artist } : {}),
    ...(media.album ? { album: media.album } : {}),
  };
}

function selectMedia(
  items: readonly MusicMedia[],
  request: string,
):
  | { readonly kind: "selected"; readonly media: MusicMedia }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly Record<string, unknown>[] } {
  const unique = [
    ...new Map(items.filter((item) => item.available).map((item) => [item.uri || item.id, item])).values(),
  ];
  if (unique.length === 0) return { kind: "not_found" };
  if (unique.length === 1) return { kind: "selected", media: unique[0] as MusicMedia };

  const ranked = unique
    .map((media, index) => ({ media, index, score: mediaScore(media, request) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const first = ranked[0];
  const second = ranked[1];
  if (
    first &&
    ((first.score >= 0.95 && first.score > (second?.score ?? 0)) ||
      (first.score >= 0.6 && first.score - (second?.score ?? 0) >= 0.2))
  ) {
    return { kind: "selected", media: first.media };
  }
  return {
    kind: "ambiguous",
    candidates: ranked.slice(0, CANDIDATE_LIMIT).map(({ media }) => mediaCandidate(media)),
  };
}

function selected(player: MusicPlayer, media?: MusicMedia): Selection {
  return {
    player: { id: player.id, name: player.name },
    ...(media ? { media: { id: media.id, uri: media.uri, type: media.type, name: media.name } } : {}),
  };
}

function sameMedia(media: MusicMedia | null, expected: MusicMedia): boolean {
  return media !== null && (media.uri === expected.uri || media.id === expected.id);
}

function queueVerified(queue: MusicQueue, media: MusicMedia, mode: MusicQueueMode): boolean {
  if (queue.state !== "playing") return false;
  const item = queue.items.find((candidate) => sameMedia(candidate.media, media));
  if (!item) return false;
  if (queue.currentIndex === null || item.index === null) return true;
  if (item.index === queue.currentIndex) return true;
  return mode === "play_next" ? item.index === queue.currentIndex + 1 : item.index > queue.currentIndex;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function verify(
  adapter: MusicAdapter,
  player: MusicPlayer,
  media: MusicMedia,
  mode: MusicQueueMode,
  signal: AbortSignal,
  options: Required<MusicPlayMachineOptions>,
): Promise<boolean> {
  const deadline = new AbortController();
  const onAbort = () => deadline.abort(signal.reason);
  if (signal.aborted) deadline.abort(signal.reason);
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => deadline.abort(new Error("verification window elapsed")),
    options.verificationWindowMs,
  );
  try {
    for (let attempt = 0; attempt < options.verificationAttempts; attempt += 1) {
      if (mode === "replace") {
        const status = await adapter.playerStatus(player.id, deadline.signal);
        if (status.player.state === "playing" && sameMedia(status.nowPlaying.media, media)) return true;
      } else {
        const queue = await adapter.queue(player.id, 25, deadline.signal);
        if (queueVerified(queue, media, mode)) return true;
      }
      if (attempt + 1 < options.verificationAttempts) await wait(options.verificationIntervalMs, deadline.signal);
    }
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function failure(
  error: unknown,
  queueMode: MusicQueueMode,
  selection: Selection = {},
  mutationAttempted = false,
): MusicPlayResult {
  if (error instanceof MusicAdapterError) {
    if (
      mutationAttempted &&
      error.dispatched &&
      ["timeout", "cancelled", "unavailable", "protocol"].includes(error.kind)
    ) {
      return { outcome: "accepted_unverified", queueMode, ...selection };
    }
    if (error.kind === "unavailable" || error.kind === "authentication")
      return { outcome: "unavailable", queueMode, ...selection };
    if (error.kind === "upstream") return { outcome: "rejected", queueMode, ...selection };
    if (error.kind === "not_found") return { outcome: "not_found", queueMode, ...selection };
    if (error.kind === "cancelled")
      return { outcome: mutationAttempted ? "accepted_unverified" : "rejected", queueMode, ...selection };
    return { outcome: "failed", queueMode, ...selection };
  }
  if (mutationAttempted) return { outcome: "accepted_unverified", queueMode, ...selection };
  return { outcome: "failed", queueMode, ...selection };
}

/** Executes the composed operation directly against the attenuated adapter.
 * It deliberately has no broker dependency: one outer tool dispatch is the
 * complete permission boundary and internal operations cannot recursively prompt. */
export async function runMusicPlay(
  adapter: MusicAdapter,
  input: MusicPlayRequest,
  signal: AbortSignal,
  configured: MusicPlayMachineOptions = {},
): Promise<MusicPlayResult> {
  const options: Required<MusicPlayMachineOptions> = {
    verificationAttempts: configured.verificationAttempts ?? 3,
    verificationIntervalMs: configured.verificationIntervalMs ?? 150,
    verificationWindowMs: configured.verificationWindowMs ?? 2_500,
  };
  let choice: Selection = {};
  let mutationAttempted = false;
  try {
    if (signal.aborted) return { outcome: "rejected", queueMode: input.queueMode };
    const resolution = resolveMusicPlayer(await adapter.listPlayers(signal), input.player);
    if (resolution.kind === "ambiguous") {
      return {
        outcome: "ambiguous_room",
        queueMode: input.queueMode,
        candidates: resolution.matches,
      };
    }
    if (resolution.kind === "not_found" || !resolution.player.available) {
      return { outcome: "no_available_player", queueMode: input.queueMode };
    }
    const player = resolution.player;
    choice = selected(player);

    const mediaResolution = selectMedia(
      await adapter.search(input.request, { limit: SEARCH_LIMIT }, signal),
      input.request,
    );
    if (mediaResolution.kind === "not_found") return { outcome: "not_found", queueMode: input.queueMode, ...choice };
    if (mediaResolution.kind === "ambiguous") {
      return {
        outcome: "ambiguous_media",
        queueMode: input.queueMode,
        ...choice,
        candidates: mediaResolution.candidates,
      };
    }
    const media = mediaResolution.media;
    choice = selected(player, media);
    if (signal.aborted) return { outcome: "rejected", queueMode: input.queueMode, ...choice };

    mutationAttempted = true;
    const acknowledgement = await adapter.play(player.id, media.uri, input.queueMode, signal);
    if (acknowledgement.outcome === "accepted_unverified") {
      return { outcome: "accepted_unverified", queueMode: input.queueMode, ...choice };
    }
    try {
      const verified = await verify(adapter, player, media, input.queueMode, signal, options);
      return { outcome: verified ? "playing" : "accepted_unverified", queueMode: input.queueMode, ...choice };
    } catch {
      return { outcome: "accepted_unverified", queueMode: input.queueMode, ...choice };
    }
  } catch (error) {
    return failure(error, input.queueMode, choice, mutationAttempted);
  }
}
