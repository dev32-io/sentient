#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import variants from "../shared/config/build-variants.json";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("usage: generate-ios-build-variants.ts <output-dir>");
await mkdir(outputDir, { recursive: true });

for (const name of ["Debug", "Release"] as const) {
  const identity = variants[name];
  const local = name === "Debug" ? '#include "../Local.xcconfig"\n\n' : "";
  await writeFile(
    resolve(outputDir, `${name}.xcconfig`),
    `// Generated from shared/config/build-variants.json. Do not edit.\n${local}PRODUCT_BUNDLE_IDENTIFIER = ${identity.bundleId}\nAPS_ENVIRONMENT = ${identity.apsEnvironment}\n`,
  );
}
