import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findChatStyleOwnershipViolations,
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

  test("allows foundation-local slate recipe resolution without creating a second token source", async () => {
    const sources = await foundationSources();
    expect(findTokenBoundaryViolations([
      ...sources,
      {
        path: "src/components/common/foundation.css",
        source: ":is(.snt-button) { --slate-face: var(--color-paper); --slate-face-hover: var(--color-paper); --slate-face-muted: var(--color-bg-elev); }",
      },
    ])).toEqual([]);
    expect(findTokenBoundaryViolations([
      ...sources,
      { path: "src/components/other.css", source: ".other { --slate-face: var(--color-paper); }" },
    ])).toContain("src/components/other.css: redeclares generated token --slate-face");
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

  test("keeps active chat and task-detail styles in their canonical owners", async () => {
    const sources: WebFoundationSource[] = [
      {
        path: "src/styles/components.css",
        source: await readFile(join(root, "gateway/webui/src/styles/components.css"), "utf8"),
      },
      {
        path: "src/components/chat/chat-messages.css",
        source: await readFile(join(root, "gateway/webui/src/components/chat/chat-messages.css"), "utf8"),
      },
    ];
    expect(findChatStyleOwnershipViolations(sources)).toEqual([]);
    expect(findChatStyleOwnershipViolations([
      { ...sources[0], source: ".message-list { gap: 1rem; }" },
      sources[1]!,
    ])).toContain("src/styles/components.css: active chat/dock selector .message-list must be owned by a component stylesheet");
  });

  test("scans complete source text so split declarations cannot bypass the boundary", () => {
    expect(findPageBoundaryViolations([
      { path: "src/components/page.css", source: ".page { gap\n: 1px; }" },
      { path: "src/components/page.tsx", source: "const props = { style\n: {} };" },
    ])).toHaveLength(2);
  });

  test("reports a finite transitional product boundary", () => {
    expect(WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST.length).toBeGreaterThan(0);
    expect(WEB_FOUNDATION_TRANSITIONAL_ALLOWLIST.every((entry) => entry.path.startsWith("src/"))).toBe(true);
  });
});
