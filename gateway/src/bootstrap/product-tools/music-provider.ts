import type { MusicAdapter } from "../../tools/music/music-adapter.js";
import { UnavailableMusicAdapter } from "../../tools/music/music-adapter.js";
import { createMusicTools } from "../../tools/music/music-tools.js";
import type { ProductToolProvider } from "../product-tool-providers.js";

/** Music-owned configuration seam. Credentials remain adapter-owned and are
 * never exposed through tool inputs or definitions. */
export interface MusicProductToolConfig extends Readonly<Record<string, unknown>> {
  readonly adapter?: MusicAdapter;
}

export const musicProductToolProvider: ProductToolProvider<"music"> = {
  group: "music",
  create: (config) => createMusicTools(isMusicAdapter(config.adapter) ? config.adapter : new UnavailableMusicAdapter()),
};

function isMusicAdapter(value: unknown): value is MusicAdapter {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Record<keyof MusicAdapter, unknown>>;
  return [
    "search",
    "browse",
    "listPlayers",
    "playerStatus",
    "queue",
    "play",
    "transport",
    "setVolume",
    "transfer",
    "group",
    "ungroup",
  ].every((method) => typeof candidate[method as keyof MusicAdapter] === "function");
}
