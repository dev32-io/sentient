import type { MusicPlayer } from "./music-adapter.js";

export type PlayerResolution =
  | { readonly kind: "resolved"; readonly player: MusicPlayer }
  | { readonly kind: "not_found"; readonly query: string }
  | {
      readonly kind: "ambiguous";
      readonly query: string;
      readonly matches: readonly Pick<MusicPlayer, "id" | "name">[];
    };

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

/** Resolve only deterministic identity/name matches. IDs and exact normalized
 * names win; partial natural names are accepted only when uniquely identifying. */
export function resolveMusicPlayer(players: readonly MusicPlayer[], query: string): PlayerResolution {
  const normalizedQuery = normalize(query);
  const byId = players.find((player) => player.id === query);
  if (byId) return { kind: "resolved", player: byId };

  const exact = players.filter((player) => normalize(player.name) === normalizedQuery);
  if (exact.length === 1) return { kind: "resolved", player: exact[0] as MusicPlayer };
  if (exact.length > 1) return ambiguous(query, exact);

  const partial = normalizedQuery ? players.filter((player) => normalize(player.name).includes(normalizedQuery)) : [];
  if (partial.length === 1) return { kind: "resolved", player: partial[0] as MusicPlayer };
  if (partial.length > 1) return ambiguous(query, partial);
  return { kind: "not_found", query };
}

function ambiguous(query: string, players: readonly MusicPlayer[]): PlayerResolution {
  return {
    kind: "ambiguous",
    query,
    matches: players.slice(0, 10).map(({ id, name }) => ({ id, name })),
  };
}
