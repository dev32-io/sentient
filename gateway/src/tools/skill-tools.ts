// The five gateway-native foreground skill tools (Skill System spec, Task 8) —
// the model's read/write surface over the per-user SkillStore (Task 5). Each is
// a `NativeToolRunner` (tool-broker.ts) the broker awaits in-turn, exactly like
// an MCP call, and each resolves its permission under the reserved `"native"`
// namespace (`NATIVE_TOOL_SERVER_KEY`).
//
// TWO STAGES, and the split is the whole design:
//   - `validate` (run BEFORE the PDP) answers every STRUCTURAL question — name
//     shape, description/body length, `tools:` membership, invisible-char lint
//     on name+description, duplicate-for-create, existence-for-update/delete —
//     AND the write-time injection scan. A non-null return is a plain tool
//     error the model relays, with NO permission prompt spent: an invalid write
//     is a model error, not an authorization question, and prompting to confirm
//     a write that would be rejected anyway just trains the user to click
//     through. Reads (`skill_list`, `skill_use`) are cheap and side-effect-free,
//     so their existence check lives in `run`, not here.
//   - `run` executes the (now-validated) request against the store. It re-parses
//     defensively — `validate` is contractually optional, so `run` must stand on
//     its own — and maps every store outcome to legible copy.
//
// WRITE-TIME SCAN (closes the fleet review's HIGH): a skill's `description` is a
// persistent channel into every future session's system prompt (Task 10), and
// it never transits the inbound gate because it is not a tool result. So
// `skill_create`/`skill_update` scan `name + description + body` as
// `channel: "skill_body"` at AUTHORING time and fail closed on any `suspicious`
// or `hostile` finding — cheaper than a crafted description riding the highest-
// trust role forever, and these are self-authored texts the user can rephrase.

import type { ImpactTier } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { scanContent } from "../security/injection-scanner.js";
import { INVISIBLE_CHARS } from "../security/text-normalizer.js";
import {
  MAX_DESCRIPTION_CHARS,
  type SkillFile,
  type SkillFileError,
  validateSkillInput,
} from "../skills/skill-file.js";
import type { SkillStore } from "../skills/skill-store.js";
import type { NativeToolRunner } from "./tool-broker.js";
import type { ToolDefinition, ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "tools", "skill-tools"]);

/** The five tool names, frozen. `phase-services` needs these BEFORE
 *  `createSkillTools(store)` exists — the store's `knownTools` set must include
 *  them, and `knownTools` is a store constructor input — so this const breaks
 *  the cycle (the names do not depend on the store). */
export const SKILL_TOOL_NAMES = ["skill_list", "skill_use", "skill_create", "skill_update", "skill_delete"] as const;
export type SkillToolName = (typeof SKILL_TOOL_NAMES)[number];

const READ_TIER: ImpactTier = "read";
const CONFIRM_TIER: ImpactTier = "confirm";

/** Short HUMAN-facing copy for the settings screen — deliberately separate from
 *  each definition's MODEL-facing `description` (which guides tool selection).
 *  Consumed by `mcp-catalog.ts`'s `projectNativeTools`, which projects these
 *  five under the `"native"` namespace with `settable: true`. */
export interface SkillToolSettingsMeta {
  readonly name: SkillToolName;
  readonly description: string;
  readonly tier: ImpactTier;
}

export const SKILL_TOOL_SETTINGS: readonly SkillToolSettingsMeta[] = [
  { name: "skill_list", description: "Let the assistant see the skills you've taught it.", tier: READ_TIER },
  { name: "skill_use", description: "Let the assistant read one of your saved skills to follow it.", tier: READ_TIER },
  { name: "skill_create", description: "Let the assistant save a new skill you teach it.", tier: CONFIRM_TIER },
  { name: "skill_update", description: "Let the assistant revise one of your saved skills.", tier: CONFIRM_TIER },
  { name: "skill_delete", description: "Let the assistant remove one of your saved skills.", tier: CONFIRM_TIER },
];

export interface SkillToolsDeps {
  /** The injection scanner (Task 3b). Injected so this module stays a pure
   *  consumer of the security surface and the scan is trivially fakeable/
   *  observable in a test. */
  scan: typeof scanContent;
  /** The tool universe a skill's `tools:` frontmatter may name — catalog names
   *  ∪ `SKILL_TOOL_NAMES` ∪ `"delegateTask"`, composed by phase-services. The
   *  SAME set the store was built with, passed here too so `validate` can answer
   *  `unknown_tools` BEFORE the PDP rather than letting `store.write` answer it
   *  only in `run`, after a prompt has already been spent. */
  knownTools: ReadonlySet<string>;
  /** Body length cap (`orchestrator.skills.max_body_chars`) — same store input,
   *  same pre-PDP reason as `knownTools`. */
  maxBodyChars: number;
}

// ---------------------------------------------------------------------------
// Result + error helpers
// ---------------------------------------------------------------------------

function ok(content: string): ToolResult {
  return { content, isError: false };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

/** Turns a structural `SkillFileError` (skill-file.ts) into legible, bounded
 *  copy the model relays to the user. */
function describeSkillFileError(error: SkillFileError): string {
  switch (error.kind) {
    case "bad_name":
      return `"${error.name}" is not a valid skill name — use lowercase letters, digits and hyphens (1-64 characters, no leading hyphen).`;
    case "description_too_long":
      return `The skill description is too long (${error.length} characters; the maximum is ${MAX_DESCRIPTION_CHARS}).`;
    case "body_too_long":
      return `The skill body is too long (${error.length} characters; the maximum is ${error.max}).`;
    case "invisible_chars":
      return `The skill body contains ${error.count} invisible or zero-width character(s); remove them and try again.`;
    case "malformed_frontmatter":
      return `The skill could not be parsed: ${error.detail}`;
    case "unknown_tools":
      return `The skill's tools list names tool(s) that do not exist: ${error.tools.join(", ")}.`;
  }
}

/** `INVISIBLE_CHARS` is non-global (safe for repeated `.test()`); the body is
 *  already linted by `validateSkillInput`, so this covers only the NAME and
 *  DESCRIPTION fields the folded-in review requires. */
function invisibleFieldError(field: "name" | "description", value: string): ToolResult | null {
  if (INVISIBLE_CHARS.test(value)) {
    return fail(`The skill ${field} contains invisible or zero-width characters; remove them and try again.`);
  }
  return null;
}

/** Write-time injection scan over `name + description + body`. A `suspicious`
 *  or `hostile` finding fails closed with the offending category named. */
function injectionScanError(scan: typeof scanContent, skill: SkillFile): ToolResult | null {
  const combined = `${skill.name}\n${skill.description}\n${skill.body}`;
  const result = scan(combined, { channel: "skill_body", source: skill.name });
  if (result.maxSeverity !== "suspicious" && result.maxSeverity !== "hostile") return null;
  const worst = result.findings.find((f) => f.severity === result.maxSeverity) ?? result.findings[0];
  const category = worst?.category ?? "prompt_injection";
  log.warn("skill-tools.scan.rejected", {
    name: skill.name,
    maxSeverity: result.maxSeverity,
    category,
    reason: "skill text matched a prompt-injection pattern at authoring time — refused, nothing written",
  });
  return fail(`The skill text looks like a prompt-injection pattern (${category}); rephrase it and try again.`);
}

/** Structural + invisible-char + injection validation shared by create and
 *  update, run BEFORE the PDP. */
function validateSkillFile(skill: SkillFile, deps: SkillToolsDeps): ToolResult | null {
  // Invisible-char lint FIRST, so a zero-width character in the name yields the
  // legible "invisible characters" error rather than the name-shape error the
  // name regex would otherwise report for the same input.
  const nameInvisible = invisibleFieldError("name", skill.name);
  if (nameInvisible) return nameInvisible;
  const descInvisible = invisibleFieldError("description", skill.description);
  if (descInvisible) return descInvisible;
  const structural = validateSkillInput(skill, { maxBodyChars: deps.maxBodyChars, knownTools: deps.knownTools });
  if (structural) return fail(describeSkillFileError(structural));
  return injectionScanError(deps.scan, skill);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const CREATE_ARGS_MESSAGE =
  "skill_create requires string arguments { name, description, body } and an optional string[] { tools }.";
const NAME_ARG_MESSAGE = "requires a string { name } argument.";
const TOOLS_ARG_MESSAGE = "The skill's tools must be an array of tool-name strings.";

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" ? value : null;
}

/** `undefined` = absent (legitimate); `"invalid"` = present but wrong shape. */
function parseTools(args: Record<string, unknown>): string[] | undefined | "invalid" {
  const value = args.tools;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return "invalid";
  return value as string[];
}

type ParseResult = { ok: true; value: SkillFile } | { ok: false; message: string };

function skillFileOf(name: string, description: string, tools: string[] | undefined, body: string): SkillFile {
  return { name, description, ...(tools && tools.length > 0 ? { tools } : {}), body };
}

function parseCreateArgs(args: Record<string, unknown>): ParseResult {
  const name = stringArg(args, "name");
  const description = stringArg(args, "description");
  const body = stringArg(args, "body");
  if (name === null || description === null || body === null) return { ok: false, message: CREATE_ARGS_MESSAGE };
  const tools = parseTools(args);
  if (tools === "invalid") return { ok: false, message: TOOLS_ARG_MESSAGE };
  return { ok: true, value: skillFileOf(name, description, tools, body) };
}

/** Merges a partial update onto the stored skill: an omitted field keeps its
 *  current value; a provided one replaces it. The name is never changed by an
 *  update (rename is delete + create). */
function mergeUpdateArgs(existing: SkillFile, args: Record<string, unknown>): ParseResult {
  const description = args.description === undefined ? existing.description : stringArg(args, "description");
  if (description === null) return { ok: false, message: "The skill description must be a string." };
  const body = args.body === undefined ? existing.body : stringArg(args, "body");
  if (body === null) return { ok: false, message: "The skill body must be a string." };
  const parsedTools = args.tools === undefined ? existing.tools : parseTools(args);
  if (parsedTools === "invalid") return { ok: false, message: TOOLS_ARG_MESSAGE };
  return { ok: true, value: skillFileOf(existing.name, description, parsedTools, body) };
}

// ---------------------------------------------------------------------------
// Store-outcome mapping + display
// ---------------------------------------------------------------------------

type WriteOutcome = ReturnType<SkillStore["write"]>;

function writeOutcomeResult(outcome: WriteOutcome, name: string, verb: "created" | "updated"): ToolResult {
  if (outcome === null) {
    log.info("skill-tools.write.ok", { name, verb });
    return ok(`Skill "${name}" ${verb}.`);
  }
  if (outcome.kind === "duplicate") {
    return fail(`A skill named "${name}" already exists. Use skill_update to change it, or pick a different name.`);
  }
  if (outcome.kind === "path_refused") {
    log.warn("skill-tools.write.path-refused", { name, reason: "store refused the name as a path escape" });
    return fail(`The skill name "${name}" is blocked on this device.`);
  }
  return fail(describeSkillFileError(outcome));
}

/** Local (not UTC) YYYY-MM-DD, matching the logging rule's local-clock stance
 *  for anything the user reads by date. */
function formatUpdatedDate(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI tools shape, matching tool-types.ts)
// ---------------------------------------------------------------------------

const NAME_PROPERTY = { type: "string", description: "The exact skill name (lowercase-kebab)." } as const;

function definitionFor(name: SkillToolName, description: string, parameters: Record<string, unknown>): ToolDefinition {
  const tier = SKILL_TOOL_SETTINGS.find((s) => s.name === name)?.tier ?? CONFIRM_TIER;
  return {
    name,
    description,
    parameters,
    category: "foreground",
    tier,
    productGroup: "skills",
    defaultExposure: "standard",
  };
}

const skillListDefinition = definitionFor(
  "skill_list",
  "List the user's saved skills — name, description, and last-updated date. Consult this to discover which skills you can apply before answering a request that might match one.",
  { type: "object", properties: {}, additionalProperties: false },
);

const skillUseDefinition = definitionFor(
  "skill_use",
  "Read the full instructions of one saved skill by name, so you can follow it. Call skill_list first if you do not already know the exact name.",
  { type: "object", properties: { name: NAME_PROPERTY }, required: ["name"], additionalProperties: false },
);

const skillCreateDefinition = definitionFor(
  "skill_create",
  "Save a new skill the user is teaching you: a name, a one-line description, and a Markdown body of instructions. Optionally list the tool names the skill relies on.",
  {
    type: "object",
    properties: {
      name: NAME_PROPERTY,
      description: { type: "string", description: "One line shown when listing skills and in the skills index." },
      body: { type: "string", description: "The skill's full instructions, in Markdown." },
      tools: { type: "array", items: { type: "string" }, description: "Tool names this skill uses (optional)." },
    },
    required: ["name", "description", "body"],
    additionalProperties: false,
  },
);

const skillUpdateDefinition = definitionFor(
  "skill_update",
  "Revise an existing saved skill by name. Provide only the fields you want to change — description, body, or tools; omitted fields are left as they are.",
  {
    type: "object",
    properties: {
      name: NAME_PROPERTY,
      description: { type: "string", description: "New one-line description (optional)." },
      body: { type: "string", description: "New Markdown instructions (optional)." },
      tools: { type: "array", items: { type: "string" }, description: "New tool-name list (optional)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
);

const skillDeleteDefinition = definitionFor("skill_delete", "Delete a saved skill by name.", {
  type: "object",
  properties: { name: NAME_PROPERTY },
  required: ["name"],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function noSkillError(name: string | null, action: string): ToolResult {
  return fail(`No skill named "${name ?? ""}" to ${action}. Use skill_list to see your saved skills.`);
}

function createSkillListRunner(store: SkillStore): NativeToolRunner {
  return {
    definition: skillListDefinition,
    async run(): Promise<ToolResult> {
      const metas = store.list();
      if (metas.length === 0) return ok("You have no skills yet.");
      const lines = metas.map((m) => `${m.name} — ${m.description} (updated ${formatUpdatedDate(m.updatedAt)})`);
      log.info("skill-tools.list", { count: metas.length });
      return ok(lines.join("\n"));
    },
  };
}

function createSkillUseRunner(store: SkillStore): NativeToolRunner {
  return {
    definition: skillUseDefinition,
    validate(args) {
      if (stringArg(args, "name") === null) return fail(`skill_use ${NAME_ARG_MESSAGE}`);
      return null;
    },
    async run(args): Promise<ToolResult> {
      const name = stringArg(args, "name");
      const skill = name === null ? null : store.read(name);
      if (!skill) return noSkillError(name, "read");
      log.info("skill-tools.use", { name });
      return ok(skill.body);
    },
  };
}

function createSkillCreateRunner(store: SkillStore, deps: SkillToolsDeps): NativeToolRunner {
  return {
    definition: skillCreateDefinition,
    validate(args) {
      const parsed = parseCreateArgs(args);
      if (!parsed.ok) return fail(parsed.message);
      const invalid = validateSkillFile(parsed.value, deps);
      if (invalid) return invalid;
      if (store.read(parsed.value.name) !== null) {
        return fail(`A skill named "${parsed.value.name}" already exists. Use skill_update to change it.`);
      }
      return null;
    },
    async run(args): Promise<ToolResult> {
      const parsed = parseCreateArgs(args);
      if (!parsed.ok) return fail(parsed.message);
      const invalid = validateSkillFile(parsed.value, deps);
      if (invalid) return invalid;
      return writeOutcomeResult(store.write(parsed.value, { overwrite: false }), parsed.value.name, "created");
    },
  };
}

function createSkillUpdateRunner(store: SkillStore, deps: SkillToolsDeps): NativeToolRunner {
  return {
    definition: skillUpdateDefinition,
    validate(args) {
      const name = stringArg(args, "name");
      if (name === null) return fail(`skill_update ${NAME_ARG_MESSAGE}`);
      const existing = store.read(name);
      if (!existing) return noSkillError(name, "update");
      const merged = mergeUpdateArgs(existing, args);
      if (!merged.ok) return fail(merged.message);
      return validateSkillFile(merged.value, deps);
    },
    async run(args): Promise<ToolResult> {
      const name = stringArg(args, "name");
      const existing = name === null ? null : store.read(name);
      if (!existing) return noSkillError(name, "update");
      const merged = mergeUpdateArgs(existing, args);
      if (!merged.ok) return fail(merged.message);
      const invalid = validateSkillFile(merged.value, deps);
      if (invalid) return invalid;
      return writeOutcomeResult(store.write(merged.value, { overwrite: true }), merged.value.name, "updated");
    },
  };
}

function createSkillDeleteRunner(store: SkillStore): NativeToolRunner {
  return {
    definition: skillDeleteDefinition,
    validate(args) {
      const name = stringArg(args, "name");
      if (name === null) return fail(`skill_delete ${NAME_ARG_MESSAGE}`);
      if (store.read(name) === null) return noSkillError(name, "delete");
      return null;
    },
    async run(args): Promise<ToolResult> {
      const name = stringArg(args, "name");
      if (name === null) return fail(`skill_delete ${NAME_ARG_MESSAGE}`);
      if (!store.remove(name)) return noSkillError(name, "delete");
      log.info("skill-tools.delete", { name });
      return ok(`Skill "${name}" deleted.`);
    },
  };
}

/** Builds the five skill-tool runners for ONE user's store, ready to hand to
 *  `ToolBrokerDeps.nativeTools`. */
export function createSkillTools(store: SkillStore, deps: SkillToolsDeps): Map<string, NativeToolRunner> {
  const runners: Record<SkillToolName, NativeToolRunner> = {
    skill_list: createSkillListRunner(store),
    skill_use: createSkillUseRunner(store),
    skill_create: createSkillCreateRunner(store, deps),
    skill_update: createSkillUpdateRunner(store, deps),
    skill_delete: createSkillDeleteRunner(store),
  };
  return new Map(SKILL_TOOL_NAMES.map((name) => [name, runners[name]]));
}
