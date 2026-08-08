// Per-user filesystem store for SKILL.md skills (Skill System spec, Task 5).
// Layout: `<root>/<name>/SKILL.md`. All parsing, structural validation, and
// serialization is delegated to skill-file.ts (Task 4) — this file owns only
// the filesystem surface: atomic writes, corrupt-skip on list/read, and the
// symlink-escape guard (spec §3 "no traversal, no symlink following").
//
// `root` is caller-supplied (the composition root passes `<userDir>/skills`,
// per FileScope integration at T8) — this module has no opinion on where the
// user dir lives, only on what happens inside it.

import { randomUUID } from "node:crypto";
import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { getLog } from "../logging/logger.js";
import {
  type SkillFile,
  type SkillFileError,
  parseSkillFile,
  serializeSkillFile,
  validateSkillInput,
} from "./skill-file.js";

const log = getLog(["sentient", "skills", "store"]);

const SKILL_FILENAME = "SKILL.md";

export interface SkillMeta {
  name: string;
  description: string;
  updatedAt: number;
}

export interface SkillStore {
  list(): SkillMeta[];
  read(name: string): SkillFile | null;
  /** `null` = ok. `{kind:"path_refused"}` is distinct from `{kind:"duplicate"}`:
   *  a duplicate is escapable via `overwrite:true`; a path refusal (the name
   *  resolves outside the store root via a symlink) is refused unconditionally
   *  — retrying with `overwrite:true` must fail the same way, not silently
   *  follow the symlink. This is a local union extension; T4's `SkillFileError`
   *  is untouched. */
  write(
    skill: SkillFile,
    opts: { overwrite: boolean },
  ): SkillFileError | { kind: "duplicate" } | { kind: "path_refused" } | null;
  remove(name: string): boolean;
}

export function createSkillStore(
  root: string,
  opts: { maxBodyChars: number; knownTools: ReadonlySet<string> },
): SkillStore {
  mkdirSync(root, { recursive: true });
  const resolvedRoot = realpathSync(root);

  const skillDirPath = (name: string): string => join(root, name);
  const skillFilePath = (dirPath: string): string => join(dirPath, SKILL_FILENAME);

  function dirExists(dirPath: string): boolean {
    try {
      lstatSync(dirPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves `dirPath` and confirms the result sits inside `resolvedRoot`.
   * Returns the realpath on success. Returns `null` when the path is absent
   * (no log — the ordinary "no such skill" case) or when it escapes the root
   * via a symlink (WARN — refused, never followed; spec §3).
   */
  function guardedRealpath(dirPath: string, name: string): string | null {
    let real: string;
    try {
      real = realpathSync(dirPath);
    } catch {
      return null;
    }
    if (real !== resolvedRoot && !real.startsWith(resolvedRoot + sep)) {
      log.warn("store.symlink-refused", { name, resolved: real, root: resolvedRoot });
      return null;
    }
    return real;
  }

  /** Shared load path for `read()` and `list()`: parse a skill dir that has
   *  already passed the symlink guard, enforcing the name-matches-dir
   *  invariant the store's own `write()` constructs by construction — a
   *  mismatch here can only mean on-disk tampering/corruption. */
  function loadSkill(realDir: string, dirName: string): SkillFile | null {
    let raw: string;
    try {
      raw = readFileSync(skillFilePath(realDir), "utf8");
    } catch {
      log.warn("store.skip", { name: dirName, reason: "missing SKILL.md" });
      return null;
    }
    const result = parseSkillFile(raw, { maxBodyChars: opts.maxBodyChars });
    if (!result.ok) {
      log.warn("store.skip", { name: dirName, reason: result.error.kind });
      return null;
    }
    if (result.skill.name !== dirName) {
      log.warn("store.skip", {
        name: dirName,
        reason: "name-dir-mismatch",
        frontmatterName: result.skill.name,
      });
      return null;
    }
    return result.skill;
  }

  return {
    list(): SkillMeta[] {
      let entries: Dirent[];
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }

      const metas: SkillMeta[] = [];
      for (const entry of entries) {
        if (entry.isFile()) continue; // stray file at root, not a skill dir
        const name = entry.name;
        const real = guardedRealpath(skillDirPath(name), name);
        if (real === null) continue;
        const skill = loadSkill(real, name);
        if (!skill) continue;
        metas.push({
          name: skill.name,
          description: skill.description,
          updatedAt: statSync(skillFilePath(real)).mtimeMs,
        });
      }
      log.debug("store.list", { count: metas.length });
      return metas;
    },

    read(name: string): SkillFile | null {
      const real = guardedRealpath(skillDirPath(name), name);
      if (real === null) return null;
      return loadSkill(real, name);
    },

    write(
      skill: SkillFile,
      writeOpts: { overwrite: boolean },
    ): SkillFileError | { kind: "duplicate" } | { kind: "path_refused" } | null {
      const validationError = validateSkillInput(skill, {
        maxBodyChars: opts.maxBodyChars,
        knownTools: opts.knownTools,
      });
      if (validationError) return validationError;

      const dirPath = skillDirPath(skill.name);
      if (dirExists(dirPath)) {
        const real = guardedRealpath(dirPath, skill.name);
        if (real === null) {
          // Symlink escape at this name — refuse without following it, and
          // unconditionally (overwrite:true must NOT retry through it).
          // Distinct from "duplicate": a duplicate is escapable via
          // overwrite:true, a path refusal never is. guardedRealpath already
          // logged the WARN with the real reason.
          return { kind: "path_refused" };
        }
        if (!writeOpts.overwrite) {
          log.warn("store.write.duplicate", { name: skill.name });
          return { kind: "duplicate" };
        }
      }

      mkdirSync(dirPath, { recursive: true });
      const raw = serializeSkillFile(skill);
      const tmpPath = join(dirPath, `.${SKILL_FILENAME}.tmp-${randomUUID()}`);
      writeFileSync(tmpPath, raw, "utf8");
      renameSync(tmpPath, skillFilePath(dirPath));
      log.info("store.write", { name: skill.name, bytes: Buffer.byteLength(raw, "utf8") });
      return null;
    },

    remove(name: string): boolean {
      const real = guardedRealpath(skillDirPath(name), name);
      if (real === null) return false;

      let bytes = 0;
      try {
        bytes = statSync(skillFilePath(real)).size;
      } catch {
        // SKILL.md itself may already be missing/corrupt — still remove the dir.
      }

      try {
        rmSync(real, { recursive: true, force: true });
      } catch (e: unknown) {
        log.warn("store.remove.io-error", { name, reason: e instanceof Error ? e.message : String(e) });
        return false;
      }
      log.info("store.remove", { name, bytes });
      return true;
    },
  };
}
