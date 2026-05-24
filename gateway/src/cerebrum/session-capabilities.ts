import { getLog } from "../logging/logger.ts";
import type { SessionPreferences } from "./preferences.ts";

const log = getLog(["sentient", "cerebrum", "session-capabilities"]);

export interface SessionCapabilities {
  has(cap: string): boolean;
  list(): readonly string[];
}

export interface DeriveInput {
  readonly preferences: SessionPreferences;
  readonly baseGranted: ReadonlySet<string>;
}

export function deriveSessionCapabilities(input: DeriveInput): SessionCapabilities {
  const out = new Set<string>(input.baseGranted);

  // channel=text revokes audio.output even if the client supports it.
  // This is the user telling us "no audio right now" (quiet hours, library mode).
  if (input.preferences.channel === "text") {
    out.delete("audio.output");
  }

  log.debug("derive", {
    preferences: input.preferences,
    base: [...input.baseGranted],
    derived: [...out],
  });

  return {
    has(cap: string): boolean {
      return out.has(cap);
    },
    list(): readonly string[] {
      return [...out];
    },
  };
}
