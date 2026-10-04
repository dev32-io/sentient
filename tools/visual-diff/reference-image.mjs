import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";

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

// Resolve each component before consuming the next: resolve(raw) would erase
// the filesystem meaning of a symlink followed by "..". Missing output tails
// are allowed; dangling symlinks and other filesystem errors fail closed.
export async function canonicalPath(path) {
  let current = isAbsolute(path) ? sep : await realpath(process.cwd());
  for (const part of path.split(sep).filter(Boolean)) {
    const next = join(current, part);
    try {
      current = await realpath(next);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const entry = await lstat(next).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
      if (entry) throw new Error("Unresolvable output path");
      current = next;
    }
  }
  return current;
}

export function absolutePath(path, base = process.cwd()) {
  return isAbsolute(path) ? path : `${base}${sep}${path}`;
}

export async function assertPathWithin(root, path) {
  const physical = await canonicalPath(path);
  // root is anchored at the canonical repository, not an alias-selected root.
  const fromRoot = relative(root, physical);
  if (await canonicalPath(root) !== root || fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Path must stay under ${root}`);
  }
  return physical;
}

export async function assertArtifactOutput(inputs, output, root, overwriteMessage) {
  const physical = await canonicalPath(output);
  const outputStat = await stat(physical).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  for (const input of inputs) {
    const inputPath = await canonicalPath(input);
    const inputStat = await stat(inputPath).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (physical === inputPath || (outputStat && inputStat && outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino)) {
      throw new Error(overwriteMessage);
    }
  }
  await assertPathWithin(root, output);
  const entry = await lstat(output).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (entry?.isSymbolicLink()) throw new Error("Output must not be a symbolic link");
  if (outputStat && (!outputStat.isFile() || outputStat.nlink > 1)) throw new Error("Output must be an unaliased regular file");
  return physical;
}

export async function assertDisposableOutput(referencePath, outputPath, platform, repoRoot = process.cwd()) {
  const root = resolve(await realpath(repoRoot), "build", "visual-captures", platform);
  const output = await assertArtifactOutput([absolutePath(referencePath, repoRoot)], absolutePath(outputPath, repoRoot), root,
    "Implementation output must not overwrite a designer reference.");
  await mkdir(dirname(output), { recursive: true });
  return output;
}

export function defaultDiffPath(actualPath) {
  const extension = extname(actualPath);
  const stem = basename(actualPath, extension);
  return `${dirname(actualPath)}${sep}${stem}.visual-diff.png`;
}
