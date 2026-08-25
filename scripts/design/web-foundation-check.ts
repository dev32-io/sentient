import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const webRoot = join(root, "gateway/webui");
const expectedRive = "bad6f8c82fba6386233cef356adc59fa6017a7c97c0de61a377546405b1e892b";
const expectedMark = "4a50a4b3a05fc7e5bf3d094b1e3b7b517a978d8ec74dc7d66695cc0041a074f1";

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if ([".ts", ".tsx", ".css", ".html"].includes(extname(path))) result.push(path);
  }
  return result;
}

const checks: Array<[string, string, string]> = [
  ["Rive", join(webRoot, "public/assets/sentient-avatar.riv"), expectedRive],
  ["static mark", join(webRoot, "public/sentient-mark.svg"), expectedMark],
];
for (const [name, path, expected] of checks) {
  const actual = await sha256(path);
  if (actual !== expected) throw new Error(`${name} checksum mismatch: expected ${expected}, received ${actual}`);
}

for (const path of await sourceFiles(webRoot)) {
  const source = await readFile(path, "utf8");
  const runtimeReference = /(?:from\s*|import\s*\(|fetch\s*\(|new\s+URL\s*\(|url\s*\(|src\s*=\s*)["'`][^"'`]*design\/prototype\//m;
  if (runtimeReference.test(source)) throw new Error(`Production prototype runtime reference: ${relative(root, path)}`);
}

const foundation = await readFile(join(webRoot, "src/components/common/foundation.css"), "utf8");
for (const material of ["--slate-face", "--well-face", "--plate-shadow", "--float-shadow"]) {
  if (!foundation.includes(`var(${material})`)) throw new Error(`Foundation CSS does not consume generated ${material}`);
}
console.log("Web foundation assets and production boundaries verified");
