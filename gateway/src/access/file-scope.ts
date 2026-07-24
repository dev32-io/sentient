// FileScope (spec §2.5) — an L2 resource handle confined by its capability.
//
// Every path is resolved against the grant root and re-checked before any I/O.
// Cross-user access is denied by PATH, including reads, before content is ever
// touched. The handle holds a capability; it never consults a principal.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLog } from "../logging/logger.js";
import { type Capability, capabilityCoversPath } from "./capability.js";

const log = getLog(["sentient", "access", "file-scope"]);

export class PathOutsideScopeError extends Error {
  constructor(attempted: string, rootPath: string) {
    super(`path escapes capability scope: ${attempted} is outside ${rootPath}`);
    this.name = "PathOutsideScopeError";
  }
}

export interface FileScope {
  /** Resolve a scope-relative path to an absolute one, or throw if it escapes. */
  resolve(relativePath: string): string;
  readText(relativePath: string): Promise<string>;
  writeText(relativePath: string, contents: string): Promise<void>;
}

export function createFileScope(cap: Capability): FileScope {
  const resolve = (relativePath: string): string => {
    const candidate = path.resolve(cap.rootPath, relativePath);
    if (!capabilityCoversPath(cap, candidate)) {
      log.warn("path.denied", {
        reason: "outside-capability-scope",
        userId: cap.ownerUserId,
        rootPath: cap.rootPath,
        attemptedPath: relativePath.slice(0, 120),
      });
      throw new PathOutsideScopeError(relativePath, cap.rootPath);
    }
    return candidate;
  };

  return {
    resolve,
    async readText(relativePath) {
      const abs = resolve(relativePath);
      return readFile(abs, "utf8");
    },
    async writeText(relativePath, contents) {
      const abs = resolve(relativePath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, contents, "utf8");
    },
  };
}
