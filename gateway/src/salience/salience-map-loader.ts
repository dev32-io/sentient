import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { SalienceMap } from "../cerebrum/short-term-context-types.js";
import { getLog } from "../logging/logger.js";
import { type SalienceEntries, createSalienceMap } from "./salience-map.js";

const log = getLog(["sentient", "cerebrum", "salience-map-loader"]);

interface SalienceMapYaml {
  version: number;
  entries: SalienceEntries;
  tonic_modulators?: { entries: unknown[] };
}

export function loadSalienceMap(path: string): SalienceMap {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as SalienceMapYaml;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported salience_map version: ${parsed.version}`);
  }
  log.info("loaded salience map from file", {
    path,
    entryKinds: Object.keys(parsed.entries),
  });
  return createSalienceMap(parsed.entries);
}
