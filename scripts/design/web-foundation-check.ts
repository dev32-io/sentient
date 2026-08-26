import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const webRoot = join(root, "gateway/webui");
const expectedRive = "bad6f8c82fba6386233cef356adc59fa6017a7c97c0de61a377546405b1e892b";
const expectedMark = "4a50a4b3a05fc7e5bf3d094b1e3b7b517a978d8ec74dc7d66695cc0041a074f1";

export interface WebFoundationSource {
  readonly path: string;
  readonly source: string;
}

export interface TransitionalAllowlistEntry {
  readonly path: string;
  readonly reason: string;
}

/**
 * Existing product styles and controls that are intentionally outside this
 * foundation contribution. New page files are not added here; later product
 * migrations remove these entries one path at a time.
 */
export const WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST: readonly TransitionalAllowlistEntry[] = [
  { path: "src/styles/components.css", reason: "legacy global shell and non-chat product styles" },
  { path: "src/components/account-wizard/account-wizard.css", reason: "account wizard composition" },
  { path: "src/components/chat/chat-messages.css", reason: "chat product surface" },
  { path: "src/components/calendar/calendar-canvas.css", reason: "calendar product surface" },
  { path: "src/components/calendar/calendar-shell.css", reason: "calendar product surface" },
  { path: "src/components/calendar/calendar-view.css", reason: "calendar product surface" },
  { path: "src/components/calendar/event-editor.css", reason: "calendar product surface" },
  { path: "src/components/calendar/event-preview.css", reason: "calendar product surface" },
  { path: "src/components/permission/permission-dialog.css", reason: "permission product surface" },
  { path: "src/components/sessions/drawer.css", reason: "history drawer product surface" },
  { path: "src/components/settings/apply-bar/apply-bar.css", reason: "settings product composition" },
  { path: "src/components/settings/panes/panes.css", reason: "settings product composition" },
  { path: "src/components/settings/settings-shell.css", reason: "settings product composition" },
  { path: "src/components/settings/sidebar/sidebar.css", reason: "settings product composition" },
  { path: "src/components/calendar/calendar-canvas-primitives.tsx", reason: "calendar native controls" },
  { path: "src/components/calendar/calendar-shell.tsx", reason: "calendar native controls" },
  { path: "src/components/calendar/calendar-view.tsx", reason: "calendar native controls" },
  { path: "src/components/calendar/day-view.tsx", reason: "calendar native controls" },
  { path: "src/components/calendar/delete-confirmation.tsx", reason: "calendar native controls" },
  { path: "src/components/calendar/event-editor.tsx", reason: "calendar native controls" },
  { path: "src/components/calendar/event-preview.tsx", reason: "calendar native controls" },
  { path: "src/components/calendar/mutation-scope-chooser.tsx", reason: "calendar native controls" },
  { path: "src/components/calendar/year-grid.tsx", reason: "calendar native controls" },
  { path: "src/components/dock/composer-task-strip.tsx", reason: "chat composer native controls" },
  { path: "src/components/dock/composer.tsx", reason: "chat composer native controls" },
  { path: "src/components/dock/interrupt-button.tsx", reason: "chat composer native controls" },
  { path: "src/components/dock/suggestion-chips.tsx", reason: "chat composer native controls" },
  { path: "src/components/dock/voice-capture-control.tsx", reason: "chat composer native controls" },
  { path: "src/components/restart-spinner.tsx", reason: "existing restart feedback" },
  { path: "src/components/voices/AddVoiceModal.tsx", reason: "existing file-picker input" },
] as const;

const transitionalPaths = new Map(WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST.map((entry) => [entry.path, entry]));
const generatedTokenPath = "src/styles/tokens/design-foundation-v2.css";
const compatibilityTokenPath = "src/styles/tokens/compatibility.css";
const legacyTokenPaths = [
  "src/styles/tokens/colors.css",
  "src/styles/tokens/spacing.css",
  "src/styles/tokens/radius.css",
  "src/styles/tokens/typography.css",
  "src/styles/tokens/shadows.css",
  "src/styles/tokens/motion.css",
] as const;

const expectedCompatibilityAliases: Readonly<Record<string, string>> = {
  "--color-overlay-scrim": "color-mix(in oklab, var(--color-bg-sunk) 78%, transparent)",
  "--shadow-1": "var(--plate-shadow)",
  "--shadow-2": "var(--float-shadow)",
  "--shadow-inset": "var(--well-shadow)",
  "--motion-fast": "var(--motion-feedback)",
  "--motion-normal": "var(--motion-state)",
};

const tokenPrefixes = [
  "--color-",
  "--font-",
  "--line-height-",
  "--space-",
  "--radius-",
  "--shadow-",
  "--motion-",
] as const;

// The foundation component must resolve these generated recipes on the same
// element that supplies --slate-base/--slate-glow. This is a deliberate local
// cascade override, not a second token source.
const localMaterialOverrides = new Set(["--slate-face", "--slate-face-hover", "--slate-face-muted"]);

const rawControlPattern = /<(?:button|input|textarea|select|progress)\b/;
const inlineStylePattern = /\bstyle\s*(?:=|:)/i;
const visualLiteralPatterns: readonly RegExp[] = [
  /#[0-9a-f]{3,8}\b/i,
  /\b(?:rgba?|hsla?)\s*\(/i,
  /\b(?:linear|radial|conic)-gradient\s*\(/i,
  /(?:^|[;{])\s*(?:font(?:-size|-family)?|color|background(?:-color)?|border(?:-radius)?|box-shadow|text-shadow|transition|animation)\s*:/i,
  /(?:^|[;{])\s*(?:padding|margin|gap)\s*:[^;{}]*\b\d+(?:\.\d+)?(?:px|rem|em)\b/i,
];

const CANONICAL_CHAT_STYLE_CLASSES = [
  "chat-view",
  "chat-view__content",
  "chat-view__transcript",
  "message-list",
  "message-list--empty",
  "message-list--error",
  "message-list__placeholder",
  "day-divider",
  "message-bubble",
  "message-bubble--continuation",
  "message-bubble--user",
  "message-bubble__avatar-spacer",
  "message-bubble__body",
  "message-bubble__meta",
  "message-bubble__name",
  "message-bubble__sep",
  "message-bubble__text-wrap",
  "message-bubble__surface",
  "message-bubble__text-inner",
  "bubble-text",
  "bubble-text__md",
  "bubble-text__pulse",
  "bubble-text__pulse-dot",
  "bubble-text__caret",
  "bubble-speaking-wave",
  "interrupt-chip",
  "interrupt-chip--inline",
] as const;

// Task detail is rendered by the dock's task shelf. Its only owner is the
// dock-local stylesheet; the old global selectors must not come back with the
// legacy chat sheet.
const LEGACY_GLOBAL_CHAT_STYLE_CLASSES = [
  ...CANONICAL_CHAT_STYLE_CLASSES,
  "tool-inline-detail",
  "tool-inline-detail__label",
  "tool-inline-detail__preview",
] as const;

function normalizeCss(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""));
}

function declarations(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const declarationPattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const match of source.matchAll(declarationPattern)) {
    const name = match[1];
    const value = match[2];
    if (name && value) result.set(name, normalizeCss(value));
  }
  return result;
}

function isTestOrQa(path: string): boolean {
  return path.includes(".test.") || path.startsWith("src/qa/");
}

function isFoundationPath(path: string): boolean {
  return path.startsWith("src/styles/tokens/")
    || path.startsWith("src/components/common/")
    || path.startsWith("src/components/settings/primitives/");
}

function isTransitionalPath(path: string): boolean {
  return transitionalPaths.has(path);
}

function isRuntimeSource(path: string): boolean {
  return !isTestOrQa(path);
}

function hasClassSelector(source: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![A-Za-z0-9_-])`).test(source);
}

export function findChatStyleOwnershipViolations(sources: readonly WebFoundationSource[]): string[] {
  const violations: string[] = [];
  const global = sources.find((source) => source.path === "src/styles/components.css");
  const canonical = sources.find((source) => source.path === "src/components/chat/chat-messages.css");
  if (!global) return ["src/styles/components.css: legacy global stylesheet is missing from the source graph"];
  if (!canonical) return ["src/components/chat/chat-messages.css: canonical chat stylesheet is missing from the source graph"];

  const globalSource = stripComments(global.source);
  const canonicalSource = stripComments(canonical.source);
  for (const className of LEGACY_GLOBAL_CHAT_STYLE_CLASSES) {
    if (hasClassSelector(globalSource, className)) {
      violations.push(`${global.path}: active chat/dock selector .${className} must be owned by a component stylesheet`);
    }
  }
  for (const className of CANONICAL_CHAT_STYLE_CLASSES) {
    if (!hasClassSelector(canonicalSource, className)) {
      violations.push(`${canonical.path}: canonical chat selector .${className} is missing`);
    }
  }
  return violations;
}

export function findPrototypeRuntimeReferences(sources: readonly WebFoundationSource[]): string[] {
  const violations: string[] = [];
  for (const { path, source } of sources) {
    if (!isRuntimeSource(path)) continue;
    // The generated TS projection carries the canonical manifest path as
    // contract metadata. It is not an import, URL, or asset lookup.
    if (path === "src/styles/tokens/design-foundation-v2.ts") continue;
    const executable = stripComments(source);
    if (/design\/prototype\//.test(executable)) {
      violations.push(`${path}: production prototype runtime reference`);
    }
  }
  return violations;
}

export function findTokenBoundaryViolations(sources: readonly WebFoundationSource[]): string[] {
  const violations: string[] = [];
  const generated = sources.find((source) => source.path === generatedTokenPath);
  if (!generated) return [`${generatedTokenPath}: generated projection is missing`];
  const generatedTokens = declarations(generated.source);

  const compatibility = sources.find((source) => source.path === compatibilityTokenPath);
  if (!compatibility) violations.push(`${compatibilityTokenPath}: compatibility alias layer is missing`);
  else {
    const aliases = declarations(compatibility.source);
    for (const [name, expected] of Object.entries(expectedCompatibilityAliases)) {
      if (aliases.get(name) !== normalizeCss(expected)) {
        violations.push(`${compatibilityTokenPath}: ${name} must be ${expected}`);
      }
    }
    for (const name of aliases.keys()) {
      if (!(name in expectedCompatibilityAliases)) {
        violations.push(`${compatibilityTokenPath}: unexpected compatibility token ${name}`);
      }
    }
  }

  for (const { path, source } of sources) {
    if (!path.endsWith(".css") || path === generatedTokenPath) continue;
    const values = declarations(source);
    for (const [name, value] of values) {
      if (generatedTokens.has(name)) {
        if (path === "src/components/common/foundation.css" && localMaterialOverrides.has(name)) continue;
        violations.push(`${path}: redeclares generated token ${name}`);
        continue;
      }
      if (tokenPrefixes.some((prefix) => name.startsWith(prefix)) && path !== compatibilityTokenPath) {
        violations.push(`${path}: unauthorized token definition ${name}: ${value}`);
      }
    }
  }
  return violations;
}

export function findImportGraphViolations(mainSource: string, indexSource: string, htmlSource: string): string[] {
  const violations: string[] = [];
  const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;
  const generatedImport = /import\s+["']\.\/styles\/tokens\/design-foundation-v2\.css["'];?/g;
  const compatibilityImport = /import\s+["']\.\/styles\/tokens\/compatibility\.css["'];?/g;

  if (count(mainSource, generatedImport) !== 1) violations.push("src/main.tsx: generated design-foundation-v2.css must be imported exactly once");
  if (count(mainSource, compatibilityImport) !== 1) violations.push("src/main.tsx: compatibility.css must be imported exactly once");
  if (/styles\/tokens\/index\.css/.test(mainSource)) violations.push("src/main.tsx: compatibility index.css must not be in the production graph");
  if (count(mainSource, /import\s+["']\.\/styles\/components\.css["'];?/g) !== 1) violations.push("src/main.tsx: components.css must be imported exactly once");

  if (count(indexSource, /@import\s+["']\.\/design-foundation-v2\.css["'];?/g) !== 1) violations.push("src/styles/tokens/index.css: generated projection must be its only foundation import");
  if (count(indexSource, /@import\s+["']\.\/compatibility\.css["'];?/g) !== 1) violations.push("src/styles/tokens/index.css: compatibility layer must be imported exactly once");
  if (/@import\s+["']\.\/(?:colors|spacing|radius|typography|shadows|motion)\.css["']/.test(indexSource)) violations.push("src/styles/tokens/index.css: deleted legacy token import");
  if (/components\.css/.test(htmlSource) || /styles\/tokens\//.test(htmlSource)) violations.push("gateway/webui/index.html: production CSS must enter through main.tsx");
  return violations;
}

function lineNumberAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

export function findPageBoundaryViolations(sources: readonly WebFoundationSource[]): string[] {
  const violations: string[] = [];
  for (const { path, source } of sources) {
    if (isTestOrQa(path) || isFoundationPath(path) || isTransitionalPath(path)) continue;
    const content = stripComments(source);
    if (path.endsWith(".tsx") || path.endsWith(".ts")) {
      const rawControl = rawControlPattern.exec(content);
      if (rawControl) violations.push(`${path}:${lineNumberAt(content, rawControl.index)}: raw visual control outside foundation`);
      const inlineStyle = inlineStylePattern.exec(content);
      if (inlineStyle) violations.push(`${path}:${lineNumberAt(content, inlineStyle.index)}: page-local inline style outside foundation`);
    }
    if (path.endsWith(".css")) {
      for (const pattern of visualLiteralPatterns) {
        const visualLiteral = pattern.exec(content);
        if (visualLiteral) {
          violations.push(`${path}:${lineNumberAt(content, visualLiteral.index)}: page-local visual literal outside foundation`);
        }
      }
    }
  }
  return violations;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules") result.push(...await sourceFiles(path));
    }
    else if ([".ts", ".tsx", ".css", ".html"].includes(extname(path))) result.push(path);
  }
  return result;
}

export async function runWebFoundationCheck(): Promise<void> {
  const checks: Array<[string, string, string]> = [
    ["Rive", join(webRoot, "public/assets/sentient-avatar.riv"), expectedRive],
    ["static mark", join(webRoot, "public/sentient-mark.svg"), expectedMark],
  ];
  for (const [name, path, expected] of checks) {
    const actual = await sha256(path);
    if (actual !== expected) throw new Error(`${name} checksum mismatch: expected ${expected}, received ${actual}`);
  }

  const absoluteSources = await sourceFiles(webRoot);
  const sources = await Promise.all(absoluteSources.map(async (absolute) => ({
    path: relative(webRoot, absolute),
    source: await readFile(absolute, "utf8"),
  })));
  const violations = [
    ...findPrototypeRuntimeReferences(sources),
    ...findTokenBoundaryViolations(sources),
    ...findChatStyleOwnershipViolations(sources),
    ...findPageBoundaryViolations(sources),
  ];
  const mainSource = sources.find((source) => source.path === "src/main.tsx")?.source;
  const indexSource = sources.find((source) => source.path === "src/styles/tokens/index.css")?.source;
  const htmlSource = sources.find((source) => source.path === "index.html")?.source;
  if (!mainSource || !indexSource || !htmlSource) violations.push("production Web foundation entry is incomplete");
  else violations.push(...findImportGraphViolations(mainSource, indexSource, htmlSource));

  for (const legacyPath of legacyTokenPaths) {
    if (absoluteSources.some((absolute) => relative(webRoot, absolute) === legacyPath)) {
      violations.push(`${legacyPath}: legacy token file must be deleted`);
    }
  }

  const foundation = sources.find((source) => source.path === "src/components/common/foundation.css")?.source ?? "";
  for (const material of ["--slate-face", "--well-face", "--plate-shadow", "--float-shadow"]) {
    if (!foundation.includes(`var(${material})`)) violations.push(`src/components/common/foundation.css: does not consume generated ${material}`);
  }

  if (violations.length > 0) {
    throw new Error(`Web foundation boundary violations:\n${violations.join("\n")}`);
  }

  console.log("Web foundation assets, import graph, tokens, and production boundaries verified");
  console.log(`Web foundation transitional allowlist (${WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST.length} existing product paths):`);
  for (const entry of WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST) console.log(`- ${entry.path} — ${entry.reason}`);
}

if (import.meta.main) await runWebFoundationCheck();
