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

// Full authority path, not a reusable frame basename.
export function caseIdFromReference(path) {
  const normalized = resolve(path).split(sep).join("/");
  const match = /\/design\/prototype\/([^/]+)\/handoff\/(static\/[^/]+|recordings\/[^/]+\/[^/]+)\.png$/.exec(normalized);
  if (!match) throw new Error(`Expected a canonical handoff PNG: ${path}`);
  return `${match[1]}/${match[2]}`;
}

export function fixtureIdFromReference(path) {
  const id = caseIdFromReference(path);
  const parts = id.split("/");
  const leaf = parts.at(-1);
  if (parts[1] === "static") return leaf;
  const recording = parts[2].replace(/^sentient-avatar--/, "sentient-identity--");
  return `${recording}--${leaf}`;
}

export function defaultActualPath(referencePath, platform) {
  return resolve("build", "visual-captures", platform, `${caseIdFromReference(referencePath)}.png`);
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
