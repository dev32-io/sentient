import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";

const PNG_SIGNATURE = "89504e470d0a1a0a";

export async function readPngSize(path) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    throw new Error(`Expected a PNG reference: ${path}`);
  }
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`PNG is missing its IHDR header: ${path}`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

export function caseIdFromReference(path) {
  return basename(path, extname(path));
}

export function defaultActualPath(referencePath, platform) {
  return resolve("build", "visual-captures", platform, basename(referencePath));
}

export async function assertDisposableOutput(referencePath, outputPath, platform) {
  const reference = resolve(referencePath);
  const output = resolve(outputPath);
  const root = resolve("build", "visual-captures", platform);
  if (reference === output) throw new Error("Implementation output must not overwrite the designer reference");

  await mkdir(root, { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  const rootReal = await realpath(root);
  const parentReal = await realpath(dirname(output));
  const fromRoot = relative(rootReal, parentReal);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Implementation output must stay under ${rootReal}`);
  }
  try {
    if ((await lstat(output)).isSymbolicLink()) {
      throw new Error("Implementation output must not be a symbolic link");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function defaultDiffPath(actualPath) {
  const extension = extname(actualPath);
  const stem = basename(actualPath, extension);
  return join(dirname(actualPath), `${stem}.visual-diff.png`);
}
