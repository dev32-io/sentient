import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const iosRoot = join(root, "ios/App");

export interface IosDesignSource {
  readonly path: string;
  readonly source: string;
}

export interface IosDesignTransitionalEntry {
  readonly path: string;
  readonly reason: string;
}

/**
 * This contribution owns Theme and non-Calendar Settings. Calendar is listed
 * file-by-file so adding a new production file cannot silently inherit an
 * excluded directory. Chat and the QA catalog are outside this checker scope.
 */
export const IOS_DESIGN_EXCLUDED_PATHS = new Set<string>([
  "ios/App/Settings/Calendar/CalendarAgendaView.swift",
  "ios/App/Settings/Calendar/CalendarAdjacentPage.swift",
  "ios/App/Settings/Calendar/CalendarAdjacentViewport.swift",
  "ios/App/Settings/Calendar/CalendarCanvasViews.swift",
  // Calendar-owned composition, native reuse/layout, and consolidated decorative Canvas.
  "ios/App/Settings/Calendar/CalendarMonthComposition.swift",
  "ios/App/Settings/Calendar/CalendarNativeMonthRendering.swift",
  "ios/App/Settings/Calendar/CalendarNativeViewport.swift",
  "ios/App/Settings/Calendar/CalendarNativeViewportLayout.swift",
  "ios/App/Settings/Calendar/CalendarFiltersView.swift",
  "ios/App/Settings/Calendar/CalendarOverlayModels.swift",
  "ios/App/Settings/Calendar/CalendarOverlayPreviews.swift",
  "ios/App/Settings/Calendar/CalendarOverlays.swift",
  "ios/App/Settings/Calendar/CalendarScaffold.swift",
  "ios/App/Settings/Calendar/CalendarScreen.swift",
  "ios/App/Settings/Calendar/CalendarSurfacePreviews.swift",
  // Calendar's native mode Menu reuses DesignMenuTriggerLabel for all chrome.
  "ios/App/Settings/Calendar/CalendarSurfaceChrome.swift",
  "ios/App/Settings/Calendar/CalendarSurfaceSupport.swift",
  "ios/App/Settings/Calendar/CalendarViewModel.swift",
  "ios/App/QAVisualReviewCatalog.swift",
  "ios/App/QAVisualReviewInventory.swift",
]);

const IOS_DESIGN_SCOPE_PREFIXES = ["ios/App/Theme/", "ios/App/Settings/"] as const;

/** Existing specialized product visuals that remain outside this library. */
export const IOS_DESIGN_TRANSITIONAL_ALLOWLIST: readonly IosDesignTransitionalEntry[] = [
  {
    path: "ios/App/Theme/MarkdownDuskTheme.swift",
    reason: "MarkdownUI adapter shared with the excluded Chat surface",
  },
  {
    path: "ios/App/Settings/Voice/VoiceRowView.swift",
    reason: "voice preview row keeps its specialized play/select/delete composition",
  },
] as const;

const transitionalPaths = new Set(IOS_DESIGN_TRANSITIONAL_ALLOWLIST.map((entry) => entry.path));

/** Exact files that are allowed to contain the native design implementation. */
export const IOS_DESIGN_FOUNDATION_PATHS = new Set([
  "ios/App/Theme/Colors.swift",
  "ios/App/Theme/DesignCanvasKernel.swift",
  "ios/App/Theme/DesignMaterials.swift",
  "ios/App/Theme/DesignSurfaces.swift",
  "ios/App/Theme/DesignV2.swift",
  "ios/App/Theme/Tokens.swift",
  "ios/App/Theme/Typo.swift",
  "ios/App/Settings/Components/DesignButtons.swift",
  "ios/App/Settings/Components/DesignBadgedIconButton.swift",
  "ios/App/Settings/Components/DesignComposites.swift",
  "ios/App/Settings/Components/DesignControls.swift",
  "ios/App/Settings/Components/DesignIdentityControls.swift",
  "ios/App/Settings/Components/DesignRangeControls.swift",
  "ios/App/Settings/Components/DesignSelectionControls.swift",
  "ios/App/Settings/Components/DesignTextFields.swift",
  "ios/App/Settings/Components/UpdateFooter.swift",
]);

const CANONICAL_PRIMITIVES = [
  "DesignControlState",
  "DesignButtonRole",
  "DesignNoticeKind",
  "DesignButtonStyle",
  "DesignActionButton",
  "DesignIconButton",
  "DesignBadgedIconButton",
  "DesignField",
  "DesignSecureField",
  "DesignMaskedField",
  "DesignMultilineEditor",
  "DesignToggleSwitch",
  "DesignToggleRow",
  "DesignSegmentedPicker",
  "DesignSelect",
  "DesignSlider",
  "DesignChip",
  "DesignCheckbox",
  "DesignProgress",
  "DesignDivider",
  "ElevatedUserAvatar",
  "DesignPageChrome",
  "DesignCard",
  "DesignPane",
  "DesignSettingsRow",
  "DesignGroupHeader",
  "DesignCategoryRow",
  "DesignStatusBadge",
  "DesignDisclosureButton",
  "DesignMenuButton",
  "DesignDismissibleNotice",
  "DesignSelectableCard",
  "DesignSearchField",
  "SearchFilterRow",
  "AsyncNotice",
  "DesignToolbarButton",
  "DesignToolbarIconButton",
  "DesignTextButton",
  "DesignActionFooter",
  "DesignApplyFeedback",
  "DesignV2",
  "DesignTextRole",
  "DesignMetrics",
  "DesignMaterialAdapter",
  "DesignMaterialNativeProjection",
  "DesignMaterialMetrics",
  "DesignTypographyAdapter",
] as const;

const COMPATIBILITY_DELEGATES: Readonly<Record<string, readonly string[]>> = {
  CategoryRow: ["DesignCategoryRow"],
  DangerButton: ["DesignActionButton"],
  GroupHeader: ["DesignGroupHeader"],
  MonoEditor: ["DesignMultilineEditor"],
  RowSegmented: ["DesignSegmentedPicker"],
  RowSelect: ["DesignSelect"],
  RowSlider: ["DesignSlider"],
  RowToggle: ["DesignToggleRow"],
  SettingsCard: ["DesignCard"],
  SoulLoadingRow: ["DesignProgress"],
  SoulInlineError: ["AsyncNotice"],
  SoulNoticeBanner: ["AsyncNotice"],
  SoulApplyingBanner: ["AsyncNotice"],
  SoulBackButton: ["DesignToolbarIconButton"],
  SoulSaveButton: ["DesignToolbarButton"],
};

const rawControlPattern = /\b(?:TextField|SecureField|TextEditor|Slider|Picker|Toggle|ProgressView|Menu)\s*(?:\(|\{)/;
const styledButtonPattern = /\.(?:buttonStyle|font|foregroundStyle|padding|frame|background|overlay|shadow)\s*\(/;
const hardcodedFontPattern = /\.custom\s*\(\s*["']/g;
const visualLiteralPatterns: readonly RegExp[] = [
  /(?:Color|UIColor)\s*\([^\n]*(?:red:|white:|hue:)/,
  /#[0-9a-fA-F]{3,8}\b/,
  /\.(?:font|padding|frame|offset|shadow|cornerRadius|opacity|scaleEffect)\s*\([^\n]*\b\d+(?:\.\d+)?\b/,
  /(?:cornerRadius|lineWidth|minimumScaleFactor|startRadius|endRadius):\s*\d+(?:\.\d+)?\b/,
  /\.animation\s*\([^\n]*(?:duration|response|dampingFraction):\s*\d+(?:\.\d+)?\b/,
];
const pageConstantPattern =
  /\b(?:private\s+)?(?:static\s+)?let\s+\w*(?:size|width|height|radius|padding|spacing|inset|offset|opacity|scale)\w*\s*:\s*(?:CGFloat|Double)\s*=/i;

function isInScope(path: string): boolean {
  return IOS_DESIGN_SCOPE_PREFIXES.some((prefix) => path.startsWith(prefix)) && !IOS_DESIGN_EXCLUDED_PATHS.has(path);
}

function isFoundation(path: string): boolean {
  return IOS_DESIGN_FOUNDATION_PATHS.has(path);
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/\/\/.*$/gm, "");
}

function swiftDeclarations(source: string): string[] {
  return [...stripComments(source).matchAll(/\b(?:struct|enum|class)\s+(\w+)/g)].flatMap((match) => match[1] ? [match[1]] : []);
}

/** Finds duplicate canonical declarations and non-delegating legacy facades. */
export function findDuplicatePrimitiveDeclarations(sources: readonly IosDesignSource[]): string[] {
  const violations: string[] = [];
  const declarations = new Map<string, string[]>();

  for (const source of sources) {
    if (!isInScope(source.path)) continue;
    for (const declaration of swiftDeclarations(source.source)) {
      const paths = declarations.get(declaration) ?? [];
      paths.push(source.path);
      declarations.set(declaration, paths);
    }
  }

  for (const primitive of CANONICAL_PRIMITIVES) {
    const paths = declarations.get(primitive) ?? [];
    if (paths.length > 1) violations.push(`${primitive}: duplicate primitive declarations in ${paths.join(", ")}`);
  }

  for (const [legacy, delegates] of Object.entries(COMPATIBILITY_DELEGATES)) {
    for (const source of sources) {
      if (!isInScope(source.path) || !swiftDeclarations(source.source).includes(legacy)) continue;
      const executable = stripComments(source.source);
      if (!delegates.some((delegate) => executable.includes(delegate))) {
        violations.push(`${source.path}: ${legacy} must delegate to ${delegates.join(" or ")}`);
      }
    }
  }
  return violations;
}

function styledButtonLines(lines: readonly string[]): string[] {
  const violations: string[] = [];
  lines.forEach((line, index) => {
    if (!/\bButton\s*(?:\(|\{)/.test(line)) return;
    const nearby: string[] = [];
    for (let offset = 0; offset < 8 && index + offset < lines.length; offset += 1) {
      const candidate = lines[index + offset];
      if (offset > 0 && (/\bButton\s*(?:\(|\{)/.test(candidate) || /}\s*label:/.test(candidate))) break;
      nearby.push(candidate);
    }
    if (styledButtonPattern.test(nearby.join(" "))) violations.push(`${index + 1}: raw styled Button`);
  });
  return violations;
}

/** Checks raw controls and visual literals at page boundaries. */
export function findPageBoundaryViolations(sources: readonly IosDesignSource[]): string[] {
  const violations: string[] = [];
  for (const source of sources) {
    if (!isInScope(source.path) || source.path.includes("/Tests/") || source.path.endsWith(".test.swift")) continue;
    const executable = stripComments(source.source);
    const lines = executable.split("\n");

    // Font family projection is a global rule, including the foundation itself.
    // Match the complete source so formatting the first argument onto another
    // line cannot bypass the rule; report the line where `.custom` begins.
    for (const match of executable.matchAll(hardcodedFontPattern)) {
      const line = executable.slice(0, match.index).split("\n").length;
      violations.push(`${source.path}:${line}: hardcoded font family; use the generated KMP typography role`);
    }

    if (isFoundation(source.path) || transitionalPaths.has(source.path)) continue;

    lines.forEach((line, index) => {
      if (rawControlPattern.test(line)) {
        violations.push(`${source.path}:${index + 1}: raw visual control outside the Design primitive library`);
      }
      if (visualLiteralPatterns.some((pattern) => pattern.test(line))) {
        violations.push(`${source.path}:${index + 1}: page-local visual literal outside the Design foundation`);
      }
      if (pageConstantPattern.test(line)) {
        violations.push(`${source.path}:${index + 1}: page-local visual constant outside the Design foundation`);
      }
    });

    for (const line of styledButtonLines(lines)) {
      violations.push(`${source.path}:${line}: raw styled Button outside the Design primitive library`);
    }
  }
  return violations;
}

export function findIosDesignBoundaryViolations(sources: readonly IosDesignSource[]): string[] {
  return [...findDuplicatePrimitiveDeclarations(sources), ...findPageBoundaryViolations(sources)];
}

function swiftFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? swiftFiles(path) : entry.name.endsWith(".swift") ? [path] : [];
  });
}

export function readIosDesignSources(): IosDesignSource[] {
  return swiftFiles(iosRoot).map((absolute) => ({
    path: relative(root, absolute),
    source: readFileSync(absolute, "utf8"),
  }));
}

function run(): void {
  const allowlistPath = join(root, "scripts/design/ios-design-boundary-allowlist.json");
  const allowlist = new Set<string>((JSON.parse(readFileSync(allowlistPath, "utf8")) as { files: string[] }).files);
  if (allowlist.size > 0) {
    throw new Error(`iOS design boundary legacy allowlist must be empty: ${[...allowlist].join(", ")}`);
  }

  const violations = findIosDesignBoundaryViolations(readIosDesignSources());
  if (violations.length > 0) {
    console.error("iOS design boundary violations:\n" + violations.join("\n"));
    process.exit(1);
  }

  console.log("iOS design boundary check passed (KMP projection and primitive boundary are closed).");
  console.log(`iOS design transitional exclusions (${IOS_DESIGN_TRANSITIONAL_ALLOWLIST.length} exact paths):`);
  for (const entry of IOS_DESIGN_TRANSITIONAL_ALLOWLIST) console.log(`- ${entry.path} — ${entry.reason}`);
}

if (import.meta.main) run();
