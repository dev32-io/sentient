import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const iosRoot = join(root, "ios/App");
const approved = [
  "ios/App/Theme/",
  "ios/App/Foundation/",
  "ios/App/Settings/Components/",
  "ios/App/Settings/SettingsPageScaffold.swift",
  // Local DEBUG-only production-component review catalog; never a route/page.
  "ios/App/QAVisualReviewCatalog.swift",
  // Reusable product components may compose v2 tokens into visual recipes.
  // Route/page roots remain scanned so product-local literals cannot return.
  "ios/App/Chat/banner/",
  "ios/App/Chat/brand/",
  "ios/App/Chat/composer/",
  "ios/App/Chat/drawer/",
  "ios/App/Chat/message/",
  "ios/App/Chat/voice/",
  "ios/App/History/",
];
const allowlistPath = join(root, "scripts/design/ios-design-boundary-allowlist.json");
const allowlist = new Set<string>((JSON.parse(readFileSync(allowlistPath, "utf8")) as { files: string[] }).files);
if (allowlist.size > 0) {
  throw new Error(`iOS design boundary legacy allowlist must be empty: ${[...allowlist].join(", ")}`);
}

const visualLiteralPatterns = [
  /(?:Color|UIColor)\s*\([^\n]*(?:red:|white:|hue:)/,
  /#[0-9a-fA-F]{3,8}\b/,
  /\.(?:font|padding|frame|offset|shadow|cornerRadius|opacity|scaleEffect)\s*\([^\n]*\b\d+(?:\.\d+)?\b/,
  /(?:cornerRadius|lineWidth|minimumScaleFactor|startRadius|endRadius):\s*\d+(?:\.\d+)?\b/,
  /\.animation\s*\([^\n]*(?:duration|response|dampingFraction):\s*\d+(?:\.\d+)?\b/,
];

function swiftFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? swiftFiles(path) : entry.name.endsWith(".swift") ? [path] : [];
  });
}

const violations: string[] = [];
for (const absolute of swiftFiles(iosRoot)) {
  const file = relative(root, absolute);
  if (approved.some((prefix) => file === prefix || file.startsWith(prefix)) || allowlist.has(file)) continue;
  const source = readFileSync(absolute, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (visualLiteralPatterns.some((pattern) => pattern.test(line))) {
      violations.push(`${file}:${index + 1}: unauthorized visual literal: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error("iOS design boundary violations:\n" + violations.join("\n"));
  process.exit(1);
}

console.log("iOS design boundary check passed (legacy allowlist closed).");
