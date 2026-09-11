import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export const ROOT = resolve(import.meta.dir, "../..");
export const CONTRACT_PATH = join(ROOT, "shared/mobile-sdk/design-foundation-v2.json");
export const MANIFEST_PATH = join(
  ROOT,
  "design/prototype/foundation-components/assets/avatars/sentient-avatar.rive-manifest.json",
);
export const RUNTIME_PATH = join(
  ROOT,
  "design/prototype/foundation-components/assets/avatars/sentient-avatar.riv",
);

const OUTPUT_PATHS = {
  kotlin: join(
    ROOT,
    "shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/v2/DesignFoundationV2.kt",
  ),
  css: join(ROOT, "gateway/webui/src/styles/tokens/design-foundation-v2.css"),
  typescript: join(ROOT, "gateway/webui/src/styles/tokens/design-foundation-v2.ts"),
} as const;

const EXPECTED_VERSION = "2.0.0";
// Updating the canonical contract requires an intentional version/hash lock update here.
const EXPECTED_CONTRACT_SHA256 = "12c9be6961247345caa3330a6f1b1224d07560be7255f1aa9bdbd9e8ecb01d2a";
const EXPECTED_STATES = ["rest", "hover", "focus", "pressed", "selected", "on", "destructive", "disabled"];
const EXPECTED_AVATAR_STATES = ["idle", "thinking", "responding"];
const EXPECTED_COLORS = {
  bg: "#2B2621", elevated: "#332D28", sunk: "#241F1B", paper: "#39322C",
  line: "#4A4138", lineSoft: "#3E362F", ink: "#F2E8D6", inkSecondary: "#D7C6AB",
  inkTertiary: "#9E907E", inkMuted: "#706456", ember: "#F2A06A", emberSoft: "#5A3A28",
  emberDeep: "#402C22", amber: "#E9B168", sage: "#B9C8A6", sageSoft: "#3A4232",
  clay: "#9A5A3E", ok: "#5F8A5B", warn: "#C2892F", stop: "#B8442E",
};
const EXPECTED_SIZES = { xs: 11, sm: 12.5, base: 15, lg: 18, xl: 22, display: 44 };
const EXPECTED_LINE_HEIGHTS = { tight: 1.25, normal: 1.55, relaxed: 1.6 };
const EXPECTED_SPACING = { xs: 4, sm: 8, md: 12, lg: 18, xl: 26, xxl: 32, xxxl: 40 };
const EXPECTED_RADII = { sm: 8, md: 12, lg: 18, xl: 26 };

export type FoundationContract = Record<string, any>;

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireKeys(value: unknown, keys: string[], path: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  for (const key of keys) if (!(key in value)) throw new Error(`${path}.${key} is required`);
}

function equalLocked(actual: unknown, expected: unknown, path: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${path} does not match the locked v2 value`);
  }
}

/** Schema and locked-value validation at the contract boundary. */
export function validateContract(contract: FoundationContract): void {
  requireKeys(contract, ["$schema", "version", "description", "colors", "typography", "spacingPx", "radiiPx", "pill", "motion", "materials", "componentStates", "avatars"], "contract");
  equalLocked(contract.version, EXPECTED_VERSION, "version");
  equalLocked(contract.colors, EXPECTED_COLORS, "colors");
  requireKeys(contract.typography, ["families", "sizesPx", "lineHeights"], "typography");
  equalLocked(contract.typography.sizesPx, EXPECTED_SIZES, "typography.sizesPx");
  equalLocked(contract.typography.lineHeights, EXPECTED_LINE_HEIGHTS, "typography.lineHeights");
  equalLocked(contract.spacingPx, EXPECTED_SPACING, "spacingPx");
  equalLocked(contract.radiiPx, EXPECTED_RADII, "radiiPx");
  equalLocked(contract.pill, { kind: "pill", cssValue: "9999px", kotlinValue: 2147483647 }, "pill");
  equalLocked(contract.motion, { feedbackMs: 150, stateTransitionMs: 250, respondingCadenceMs: 1550 }, "motion");
  equalLocked(contract.componentStates, EXPECTED_STATES, "componentStates");
  requireKeys(contract.materials, ["physicalModel", "recipes"], "materials");
  equalLocked(contract.materials.physicalModel, {
    actionableFaces: "elevated-subtly-concave", receivingSurfaces: "recessed", broadPlates: "quiet",
    brightPerimeterRim: false, centerHighlight: false, emberUsage: ["commitment", "focus", "activity"],
  }, "materials.physicalModel");
  requireKeys(contract.materials.recipes, ["slate-face", "slate-face-hover", "slate-face-muted", "slate-top-light", "slate-contact", "slate-cast", "slate-ember-cast", "slate-shadow", "slate-shadow-hover", "slate-shadow-pressed", "slate-shadow-disabled", "well-face", "well-shadow", "well-shadow-focus", "plate-shadow", "float-shadow"], "materials.recipes");
  for (const [name, recipe] of Object.entries(contract.materials.recipes)) {
    if (typeof recipe !== "string" || recipe.length === 0) throw new Error(`materials.recipes.${name} must be a non-empty string`);
  }
  requireKeys(contract.avatars, ["sentient", "user"], "avatars");
  const avatar = contract.avatars.sentient;
  requireKeys(avatar, ["runtimeFile", "manifestPath", "manifestSha256", "runtimeSha256", "artboard", "stateMachine", "states", "triggers", "reducedMotion", "transitionDurationMs"], "avatars.sentient");
  equalLocked(avatar.runtimeFile, "sentient-avatar.riv", "avatars.sentient.runtimeFile");
  equalLocked(avatar.manifestPath, "design/prototype/foundation-components/assets/avatars/sentient-avatar.rive-manifest.json", "avatars.sentient.manifestPath");
  equalLocked(avatar.artboard, "SentientAvatar", "avatars.sentient.artboard");
  equalLocked(avatar.stateMachine, "Avatar", "avatars.sentient.stateMachine");
  equalLocked(avatar.states, EXPECTED_AVATAR_STATES, "avatars.sentient.states");
  equalLocked(avatar.triggers, { idle: "toIdle", thinking: "toThinking", responding: "toResponding" }, "avatars.sentient.triggers");
  equalLocked(avatar.reducedMotion, { input: "reducedMotion", type: "boolean" }, "avatars.sentient.reducedMotion");
  equalLocked(avatar.transitionDurationMs, 250, "avatars.sentient.transitionDurationMs");
  if (avatar.states.includes("listening")) throw new Error("listening is composer-owned and cannot be an avatar state");
}

export async function readAndValidateContract(): Promise<{ contract: FoundationContract; bytes: Uint8Array; hash: string }> {
  const bytes = await readFile(CONTRACT_PATH);
  const hash = sha256(bytes);
  if (hash !== EXPECTED_CONTRACT_SHA256) throw new Error(`contract hash mismatch: expected ${EXPECTED_CONTRACT_SHA256}, got ${hash}`);
  const contract = JSON.parse(bytes.toString()) as FoundationContract;
  validateContract(contract);

  const manifestBytes = await readFile(MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes.toString());
  if (sha256(manifestBytes) !== contract.avatars.sentient.manifestSha256) throw new Error("Rive manifest checksum mismatch");
  if (manifest.generated_asset.riv_sha256 !== contract.avatars.sentient.runtimeSha256) throw new Error("Rive descriptor checksum disagrees with its manifest");
  if (sha256(await readFile(RUNTIME_PATH)) !== contract.avatars.sentient.runtimeSha256) throw new Error("Rive runtime asset checksum mismatch");
  return { contract, bytes, hash };
}

const camelToKebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const title = (name: string) => name.replace(/(^|-)(\w)/g, (_, _dash, letter) => letter.toUpperCase());
const kotlinString = (value: string) => JSON.stringify(value).replace(/\$/g, "\\$");

export function renderCss(contract: FoundationContract, hash: string): string {
  const lines = [
    "/* GENERATED FILE — DO NOT EDIT.",
    ` * Design foundation ${contract.version}; contract sha256: ${hash}`,
    " * Source: shared/mobile-sdk/design-foundation-v2.json",
    " */",
    ":root {",
  ];
  const colorNames: Record<string, string> = {
    bg: "bg", elevated: "bg-elev", sunk: "bg-sunk", paper: "paper", line: "line", lineSoft: "line-soft",
    ink: "ink", inkSecondary: "ink-2", inkTertiary: "ink-3", inkMuted: "ink-4", ember: "accent",
    emberSoft: "accent-soft", emberDeep: "accent-50", amber: "amber", sage: "sage", sageSoft: "sage-soft",
    clay: "clay", ok: "ok", warn: "warn", stop: "stop",
  };
  for (const [name, value] of Object.entries(contract.colors)) lines.push(`  --color-${colorNames[name]}: ${value};`);
  for (const [name, value] of Object.entries(contract.typography.families)) lines.push(`  --font-${camelToKebab(name)}: ${JSON.stringify(value).replace(/^"|"$/g, "")};`);
  for (const [name, value] of Object.entries(contract.typography.sizesPx)) lines.push(`  --font-size-${camelToKebab(name)}: ${value}px;`);
  for (const [name, value] of Object.entries(contract.typography.lineHeights)) lines.push(`  --line-height-${camelToKebab(name)}: ${value};`);
  for (const [name, value] of Object.entries(contract.spacingPx)) lines.push(`  --space-${name === "xxl" ? "2xl" : name === "xxxl" ? "3xl" : camelToKebab(name)}: ${value}px;`);
  for (const [name, value] of Object.entries(contract.radiiPx)) lines.push(`  --radius-${camelToKebab(name)}: ${value}px;`);
  lines.push(`  --radius-pill: ${contract.pill.cssValue};`);
  lines.push(`  --motion-feedback: ${contract.motion.feedbackMs}ms ease;`);
  lines.push(`  --motion-state: ${contract.motion.stateTransitionMs}ms ease;`);
  lines.push(`  --motion-responding-cadence: ${contract.motion.respondingCadenceMs}ms ease-in-out;`);
  for (const [name, value] of Object.entries(contract.materials.recipes)) lines.push(`  --${name}: ${value};`);
  lines.push("}", "");
  return lines.join("\n");
}

export function renderTypescript(contract: FoundationContract, hash: string): string {
  const componentStates = contract.componentStates.map((state: string) => `  | ${JSON.stringify(state)}`).join("\n");
  const avatarStates = contract.avatars.sentient.states.map((state: string) => JSON.stringify(state)).join(" | ");
  return `// GENERATED FILE — DO NOT EDIT.\n// Design foundation ${contract.version}; contract sha256: ${hash}\n// Source: shared/mobile-sdk/design-foundation-v2.json\n\nexport const DESIGN_FOUNDATION_VERSION = ${JSON.stringify(contract.version)} as const;\nexport const DESIGN_FOUNDATION_SHA256 = ${JSON.stringify(hash)} as const;\nexport type DesignComponentState =\n${componentStates};\nexport type SentientAvatarState = ${avatarStates};\n\nexport interface DesignFoundationV2 {\n  readonly version: typeof DESIGN_FOUNDATION_VERSION;\n  readonly description: string;\n  readonly colors: Readonly<Record<string, string>>;\n  readonly typography: {\n    readonly families: Readonly<Record<string, string>>;\n    readonly sizesPx: Readonly<Record<string, number>>;\n    readonly lineHeights: Readonly<Record<string, number>>;\n  };\n  readonly spacingPx: Readonly<Record<string, number>>;\n  readonly radiiPx: Readonly<Record<string, number>>;\n  readonly pill: { readonly kind: "pill"; readonly cssValue: string; readonly kotlinValue: number };\n  readonly motion: Readonly<Record<string, number>>;\n  readonly materials: {\n    readonly physicalModel: Readonly<Record<string, string | boolean | readonly string[]>>;\n    readonly recipes: Readonly<Record<string, string>>;\n  };\n  readonly componentStates: readonly DesignComponentState[];\n  readonly avatars: {\n    readonly sentient: {\n      readonly runtimeFile: string;\n      readonly manifestPath: string;\n      readonly manifestSha256: string;\n      readonly runtimeSha256: string;\n      readonly artboard: string;\n      readonly stateMachine: string;\n      readonly states: readonly SentientAvatarState[];\n      readonly triggers: Readonly<Record<SentientAvatarState, string>>;\n      readonly reducedMotion: { readonly input: string; readonly type: "boolean" };\n      readonly transitionDurationMs: number;\n    };\n    readonly user: {\n      readonly sizesPx: readonly number[];\n      readonly tints: readonly string[];\n      readonly states: readonly string[];\n    };\n  };\n}\n\nexport const designFoundationV2 = JSON.parse(\n  String.raw\`${JSON.stringify(contract)}\`,\n) as DesignFoundationV2;\n`;
}

function kotlinObject(name: string, values: Record<string, any>, type: "Int" | "Double" | "String" | "Long"): string[] {
  const lines = [`object ${name} {`];
  for (const [key, raw] of Object.entries(values)) {
    let value = String(raw);
    if (type === "String") value = kotlinString(raw);
    if (type === "Double" && Number.isInteger(raw)) value += ".0";
    if (type === "Long") value = `0xFF${raw.slice(1)}L`;
    lines.push(`    const val ${key}: ${type} = ${value}`);
  }
  lines.push("}");
  return lines;
}

export function renderKotlin(contract: FoundationContract, hash: string): string {
  const avatar = contract.avatars.sentient;
  const lines = [
    "// GENERATED FILE — DO NOT EDIT.",
    `// Design foundation ${contract.version}; contract sha256: ${hash}`,
    "// Source: shared/mobile-sdk/design-foundation-v2.json",
    "package io.sentient.mobilesdk.design.v2",
    "",
    "object DesignFoundationV2 {",
    `    const val version: String = ${kotlinString(contract.version)}`,
    `    const val contractSha256: String = ${kotlinString(hash)}`,
    "}", "",
    ...kotlinObject("Colors", contract.colors, "Long"), "",
    ...kotlinObject("Fonts", contract.typography.families, "String"), "",
    ...kotlinObject("TypeSizes", contract.typography.sizesPx, "Double"), "",
    ...kotlinObject("LineHeights", contract.typography.lineHeights, "Double"), "",
    ...kotlinObject("Spacing", contract.spacingPx, "Double"), "",
    ...kotlinObject("Radii", contract.radiiPx, "Double"), "",
    "object Pill {",
    "    const val isTruePill: Boolean = true",
    `    const val cssValue: String = ${kotlinString(contract.pill.cssValue)}`,
    "}",
  ];
  lines.push(
    "", "object Motion {" ,
    `    const val feedbackMs: Int = ${contract.motion.feedbackMs}`,
    `    const val stateTransitionMs: Int = ${contract.motion.stateTransitionMs}`,
    `    const val respondingCadenceMs: Int = ${contract.motion.respondingCadenceMs}`,
    "}", "", "object Materials {",
  );
  for (const [name, value] of Object.entries(contract.materials.recipes)) lines.push(`    const val ${name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}: String = ${kotlinString(value as string)}`);
  lines.push("}", "", "object MaterialModel {");
  lines.push(`    const val actionableFaces: String = ${kotlinString(contract.materials.physicalModel.actionableFaces)}`);
  lines.push(`    const val receivingSurfaces: String = ${kotlinString(contract.materials.physicalModel.receivingSurfaces)}`);
  lines.push(`    const val broadPlates: String = ${kotlinString(contract.materials.physicalModel.broadPlates)}`);
  lines.push(`    const val brightPerimeterRim: Boolean = ${contract.materials.physicalModel.brightPerimeterRim}`);
  lines.push(`    const val centerHighlight: Boolean = ${contract.materials.physicalModel.centerHighlight}`);
  lines.push("    val emberUsage: List<String> = listOf(" + contract.materials.physicalModel.emberUsage.map(kotlinString).join(", ") + ")");
  lines.push("}", "", "enum class ComponentState {");
  contract.componentStates.forEach((state: string, index: number) => lines.push(`    ${state.toUpperCase()}${index === contract.componentStates.length - 1 ? "" : ","}`));
  lines.push("}", "", "enum class SentientAvatarState { IDLE, THINKING, RESPONDING }", "", "object SentientAvatar {");
  lines.push(`    const val runtimeFile: String = ${kotlinString(avatar.runtimeFile)}`);
  lines.push(`    const val manifestPath: String = ${kotlinString(avatar.manifestPath)}`);
  lines.push(`    const val manifestSha256: String = ${kotlinString(avatar.manifestSha256)}`);
  lines.push(`    const val runtimeSha256: String = ${kotlinString(avatar.runtimeSha256)}`);
  lines.push(`    const val artboard: String = ${kotlinString(avatar.artboard)}`);
  lines.push(`    const val stateMachine: String = ${kotlinString(avatar.stateMachine)}`);
  lines.push(`    const val reducedMotionInput: String = ${kotlinString(avatar.reducedMotion.input)}`);
  lines.push(`    const val transitionDurationMs: Int = ${avatar.transitionDurationMs}`);
  lines.push("    val states: List<String> = listOf(" + avatar.states.map(kotlinString).join(", ") + ")");
  lines.push("    val triggers: Map<String, String> = mapOf(" + Object.entries(avatar.triggers).map(([key, value]) => `${kotlinString(key)} to ${kotlinString(value as string)}`).join(", ") + ")");
  lines.push("}", "", "object UserAvatar {");
  lines.push("    val sizesPx: List<Int> = listOf(" + contract.avatars.user.sizesPx.join(", ") + ")");
  lines.push("    val tintRoles: List<String> = listOf(" + contract.avatars.user.tints.map(kotlinString).join(", ") + ")");
  lines.push("    val states: List<String> = listOf(" + contract.avatars.user.states.map(kotlinString).join(", ") + ")");
  lines.push("}", "");
  return lines.join("\n");
}

export function renderOutputs(contract: FoundationContract, hash: string): Record<keyof typeof OUTPUT_PATHS, string> {
  return { kotlin: renderKotlin(contract, hash), css: renderCss(contract, hash), typescript: renderTypescript(contract, hash) };
}

async function generate(): Promise<void> {
  const { contract, hash } = await readAndValidateContract();
  const outputs = renderOutputs(contract, hash);
  for (const name of Object.keys(OUTPUT_PATHS) as (keyof typeof OUTPUT_PATHS)[]) {
    await mkdir(dirname(OUTPUT_PATHS[name]), { recursive: true });
    await writeFile(OUTPUT_PATHS[name], outputs[name]);
  }
  console.log(`Generated design foundation ${contract.version} (${hash})`);
}

export function assertProjectionCurrent(committed: Uint8Array | null, generated: Uint8Array, path: string): void {
  if (!committed || !Buffer.from(committed).equals(Buffer.from(generated))) {
    throw new Error(`${path} is stale; run bun run design:foundation:generate`);
  }
}

async function check(): Promise<void> {
  const { contract, hash } = await readAndValidateContract();
  const outputs = renderOutputs(contract, hash);
  const temp = await mkdtemp(join(tmpdir(), "sentient-design-foundation-"));
  try {
    for (const name of Object.keys(OUTPUT_PATHS) as (keyof typeof OUTPUT_PATHS)[]) {
      const generated = join(temp, name);
      await writeFile(generated, outputs[name]);
      const committed = await readFile(OUTPUT_PATHS[name]).catch(() => null);
      assertProjectionCurrent(committed, await readFile(generated), OUTPUT_PATHS[name]);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  console.log(`Design foundation ${contract.version} is current (${hash})`);
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "generate") await generate();
  else if (mode === "check") await check();
  else throw new Error("usage: bun scripts/design/design-foundation-v2.ts <generate|check>");
}
