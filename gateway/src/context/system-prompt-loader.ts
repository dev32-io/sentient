import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetPath, resolveAssetRoot } from "../config/asset-root.ts";
import { getLog } from "../logging/logger.ts";

const log = getLog(["sentient", "context", "system-prompt"]);

// Load from baked-in template dir at module init. Single read; never reloaded
// at runtime since the template is fixed per build. `assetPath` resolves the
// root for every deployment shape (repo checkout, compiled binary) and fails
// loudly rather than yielding a bogus absolute path — see config/asset-root.ts.
export const DEFAULT_PERSONA = readFileSync(assetPath("templates", "persona", "default.md"), "utf8").trim();

export interface LoadSystemPromptOptions {
  readonly personaFile?: string;
  readonly runtimeDir?: string;
}

function tryRead(path: string, kind: string): string | undefined {
  try {
    const content = readFileSync(path, "utf-8").trim();
    log.info(`${kind}-loaded`, { path });
    return content;
  } catch {
    log.warn(`${kind}-missing`, { path });
    return undefined;
  }
}

export function loadSystemPrompt(opts: LoadSystemPromptOptions): string {
  const runtimeDir = opts.runtimeDir ?? resolveAssetRoot();
  const personaFile = opts.personaFile ?? "persona.md";
  const parts: string[] = [];

  const systemPrompt = tryRead(join(runtimeDir, "system_prompts", "system_prompt.md"), "system-prompt");
  if (systemPrompt) parts.push(systemPrompt);

  const persona = tryRead(join(runtimeDir, personaFile), "persona");
  parts.push(persona ?? DEFAULT_PERSONA);

  return parts.join("\n\n");
}

// Baked-in default for the compaction summarizer (spec §8). Read at module
// init, exactly like DEFAULT_PERSONA above: a missing baked-in template is a
// build error, and failing loudly at boot beats discovering it at the first
// compaction, mid-conversation.
export const DEFAULT_COMPACTION_SUMMARIZER = readFileSync(
  assetPath("templates", "prompts", "compaction-summarizer.md"),
  "utf8",
).trim();

/** Operator override first, baked-in template as the fallback — same
 *  two-tier shape as `loadSystemPrompt`, so an operator can retune the
 *  summarizer without a rebuild. */
export function loadCompactionSummarizerPrompt(opts: { runtimeDir?: string } = {}): string {
  const runtimeDir = opts.runtimeDir ?? resolveAssetRoot();
  const override = tryRead(join(runtimeDir, "system_prompts", "compaction_summarizer.md"), "compaction-summarizer");
  return override ?? DEFAULT_COMPACTION_SUMMARIZER;
}
