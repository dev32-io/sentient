import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { assetPath } from "../config/asset-root.ts";
import { getLog } from "../logging/logger.js";
import { getSharedTemplatesDir } from "../user-auth/paths.js";

const log = getLog(["sentient", "gateway", "profile-store", "template-loader"]);

// Baked-in canonical templates ship at `<asset root>/templates/` in every
// deployment shape; config/asset-root.ts owns resolving that root. Operator
// overrides at `<gatewayRoot>/shared/templates/<name>.md` win when present.
function getBuiltinTemplatesDir(): string {
  return assetPath("templates");
}

export type TemplateError = "not-found" | "io-error";

export interface TemplateLoader {
  load(name: string): Promise<Result<string, TemplateError>>;
  loadOrBuiltinDefault(): Promise<Result<string, TemplateError>>;
  invalidate(name: string): void;
}

export function createTemplateLoader(): TemplateLoader {
  const cache = new Map<string, string>();

  async function readTemplate(name: string): Promise<Result<string, TemplateError>> {
    const cached = cache.get(name);
    if (cached !== undefined) {
      return { ok: true, value: cached };
    }

    const filePath = join(getSharedTemplatesDir(), `${name}.md`);
    try {
      const content = await fs.readFile(filePath, "utf8");
      cache.set(name, content);
      log.debug("load.from-disk", { name, bytes: content.length });
      return { ok: true, value: content };
    } catch (err) {
      const isNotFound = typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";

      if (isNotFound) {
        return { ok: false, error: "not-found" };
      }

      log.warn("load.failed", { name, reason: String(err) });
      return { ok: false, error: "io-error" };
    }
  }

  async function load(name: string): Promise<Result<string, TemplateError>> {
    return readTemplate(name);
  }

  async function loadOrBuiltinDefault(): Promise<Result<string, TemplateError>> {
    const override = await readTemplate("default");
    if (override.ok) return override;

    const builtinPath = join(getBuiltinTemplatesDir(), "default.md");
    try {
      const content = await fs.readFile(builtinPath, "utf8");
      log.debug("loadOrBuiltinDefault.using-builtin", { path: builtinPath, bytes: content.length });
      return { ok: true, value: content };
    } catch (err) {
      log.warn("loadOrBuiltinDefault.builtin-missing", { path: builtinPath, reason: String(err) });
      return { ok: false, error: "io-error" };
    }
  }

  function invalidate(name: string): void {
    cache.delete(name);
    log.debug("invalidate", { name });
  }

  return { load, loadOrBuiltinDefault, invalidate };
}
