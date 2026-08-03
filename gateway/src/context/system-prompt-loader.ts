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

/**
 * [missLevel] exists because "the file isn't there" means two different things
 * in the two tiers. A missing BAKED-IN template is a build defect and warrants
 * a WARN; a missing OPERATOR OVERRIDE is the normal state of every install
 * that never customised anything, and warning on it would put a WARN on the
 * hot path of an auxiliary task — which the e2e gate reads as a failure.
 */
function tryRead(path: string, kind: string, missLevel: "warn" | "debug" = "warn"): string | undefined {
  try {
    const content = readFileSync(path, "utf-8").trim();
    log.info(`${kind}-loaded`, { path });
    return content;
  } catch {
    log[missLevel](`${kind}-missing`, { path });
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

// ---------------------------------------------------------------------------
// Auxiliary-task templates (spec §6)
// ---------------------------------------------------------------------------

/** Where the two tiers live, relative to the asset root
 *  (`orchestrator.auxiliary.override_dir` / `.template_dir`). */
export interface AuxiliaryTemplateDirs {
  readonly templateDir: string;
  readonly overrideDir: string;
}

/**
 * Resolved templates, keyed by `<overrideDir>/<templateDir>/<file>`.
 *
 * READ ONCE PER PROCESS, matching `loadSystemPrompt`'s own contract: dev
 * restarts on save (`bun --watch`) and prod restarts on deploy, so an operator
 * edit still lands without a rebuild. Without the memo this is a synchronous
 * two-path `readFileSync` on the settle path of every single turn that titles.
 */
const auxiliaryTemplates = new Map<string, string | null>();

/**
 * One auxiliary-task template: operator override FIRST, baked-in as the
 * fallback — the same two-tier shape as `loadSystemPrompt` and
 * `loadCompactionSummarizerPrompt`, applied to a DIRECTORY of templates rather
 * than one fixed file. That is what makes a new auxiliary task (tags,
 * follow-up suggestions, summarisation) a template plus a caller.
 *
 * `null` when NEITHER tier has the file — the caller fails closed rather than
 * prompting the model with nothing.
 */
export function loadAuxiliaryTemplate(
  templateFile: string,
  dirs: AuxiliaryTemplateDirs,
  opts: { runtimeDir?: string } = {},
): string | null {
  const runtimeDir = opts.runtimeDir ?? resolveAssetRoot();
  const key = join(runtimeDir, dirs.overrideDir, dirs.templateDir, templateFile);
  const cached = auxiliaryTemplates.get(key);
  if (cached !== undefined) return cached;

  const override = tryRead(join(runtimeDir, dirs.overrideDir, templateFile), "auxiliary-template-override", "debug");
  const resolved = override ?? tryRead(join(runtimeDir, dirs.templateDir, templateFile), "auxiliary-template") ?? null;
  auxiliaryTemplates.set(key, resolved);
  return resolved;
}
