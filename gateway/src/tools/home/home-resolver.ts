import type { HomeEntity } from "./home-adapter.js";

export interface HomeCandidate {
  entityId: string;
  name: string;
  areaId: string | null;
}

export type HomeResolution =
  | { outcome: "succeeded"; entity: HomeEntity }
  | { outcome: "not_found" }
  | { outcome: "ambiguous"; candidates: HomeCandidate[] };

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/g, " ");
}

function candidate(entity: HomeEntity): HomeCandidate {
  return { entityId: entity.entityId, name: entity.name, areaId: entity.areaId };
}

/** Deterministic target resolution: stable id, exact name/alias, then bounded
 * contains matches. Every stage applies domain and area before deciding. */
export function resolveHomeEntity(
  entities: readonly HomeEntity[],
  query: string,
  options: { domains?: readonly string[]; areaId?: string; maxCandidates?: number } = {},
): HomeResolution {
  const needle = normalize(query);
  if (!needle) return { outcome: "not_found" };
  const domains = options.domains ? new Set(options.domains) : null;
  const eligible = entities.filter((entity) => {
    const domain = entity.entityId.split(".")[0];
    return (
      (!domains || (domain !== undefined && domains.has(domain))) &&
      (!options.areaId || entity.areaId === options.areaId)
    );
  });

  const idMatch = eligible.find((entity) => normalize(entity.entityId) === needle);
  if (idMatch) return { outcome: "succeeded", entity: idMatch };

  const exact = eligible.filter(
    (entity) => normalize(entity.name) === needle || entity.aliases.some((alias) => normalize(alias) === needle),
  );
  const [onlyExact] = exact;
  if (exact.length === 1 && onlyExact) return { outcome: "succeeded", entity: onlyExact };

  const matches =
    exact.length > 1
      ? exact
      : eligible.filter((entity) =>
          [entity.name, entity.entityId, ...entity.aliases].some((value) => normalize(value).includes(needle)),
        );
  if (matches.length === 0) return { outcome: "not_found" };
  const [onlyMatch] = matches;
  if (matches.length === 1 && onlyMatch) return { outcome: "succeeded", entity: onlyMatch };
  return {
    outcome: "ambiguous",
    candidates: matches
      .map(candidate)
      .sort((a, b) => a.entityId.localeCompare(b.entityId))
      .slice(0, options.maxCandidates ?? 8),
  };
}
