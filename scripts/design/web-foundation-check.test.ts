import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findImportGraphViolations,
  findPageBoundaryViolations,
  findPrototypeRuntimeReferences,
  findTokenBoundaryViolations,
  WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST,
  type WebFoundationSource,
} from "./web-foundation-check";

const root = join(import.meta.dir, "../..");

async function foundationSources(): Promise<WebFoundationSource[]> {
  return [
    {
      path: "src/styles/tokens/design-foundation-v2.css",
      source: await readFile(join(root, "gateway/webui/src/styles/tokens/design-foundation-v2.css"), "utf8"),
    },
    {
      path: "src/styles/tokens/compatibility.css",
      source: await readFile(join(root, "gateway/webui/src/styles/tokens/compatibility.css"), "utf8"),
    },
  ];
}

describe("Web foundation boundary", () => {
  test("rejects executable prototype references but permits generated manifest metadata", () => {
    expect(findPrototypeRuntimeReferences([
      { path: "src/components/page.tsx", source: 'const image = fetch("/design/prototype/avatar.riv");' },
    ])).toHaveLength(1);
    expect(findPrototypeRuntimeReferences([
      { path: "src/styles/tokens/design-foundation-v2.ts", source: 'manifestPath: "design/prototype/foundation-components/assets/manifest.json"' },
    ])).toEqual([]);
  });

  test("rejects a duplicate generated token and accepts the reviewed aliases", async () => {
    const sources = await foundationSources();
    expect(findTokenBoundaryViolations(sources)).toEqual([]);
    expect(findTokenBoundaryViolations([
      ...sources,
      { path: "src/components/page.css", source: ":root { --color-bg: #000; }" },
    ])).toContain("src/components/page.css: redeclares generated token --color-bg");
  });

  test("rejects raw controls and page-local visual literals outside the explicit migration boundary", () => {
    expect(findPageBoundaryViolations([
      { path: "src/components/page.tsx", source: "<button style={{ color: 'red' }}>Save</button>" },
    ]).length).toBe(2);
    expect(findPageBoundaryViolations([
      { path: "src/components/dock/composer.tsx", source: "<textarea />" },
    ])).toEqual([]);
  });

  test("keeps the production stylesheet graph rooted at the generated projection", () => {
    expect(findImportGraphViolations(
      'import "./styles/tokens/design-foundation-v2.css";\nimport "./styles/tokens/compatibility.css";\nimport "./styles/components.css";',
      '@import "./design-foundation-v2.css";\n@import "./compatibility.css";',
      '<script type="module" src="/src/main.tsx"></script>',
    )).toEqual([]);
    expect(findImportGraphViolations(
      'import "./styles/tokens/index.css";\nimport "./styles/tokens/design-foundation-v2.css";',
      '@import "./colors.css";',
      '<link rel="stylesheet" href="/src/styles/components.css" />',
    ).length).toBeGreaterThan(0);
  });

  test("reports a finite transitional product boundary", () => {
    expect(WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST.length).toBeGreaterThan(0);
    expect(WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST.every((entry) => entry.path.startsWith("src/"))).toBe(true);
  });
});
