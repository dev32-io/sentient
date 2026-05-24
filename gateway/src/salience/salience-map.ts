import type { SalienceMap } from "../cerebrum/short-term-context-types.js";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "cerebrum", "salience-map"]);

export type SalienceEntries = Record<string, Record<string, number>>;

const EMPTY: Readonly<Record<string, number>> = Object.freeze({});

export function createSalienceMap(entries: SalienceEntries): SalienceMap {
  const frozen = Object.freeze(
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, Object.freeze({ ...v })])),
  );

  log.info("salience map loaded", {
    entryCount: Object.keys(frozen).length,
    effectNames: [...new Set(Object.values(frozen).flatMap(Object.keys))],
  });

  return {
    lookup(kind: string): Readonly<Record<string, number>> {
      return frozen[kind] ?? EMPTY;
    },
  };
}
