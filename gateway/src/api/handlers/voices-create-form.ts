import { normalizeLanguage } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import { clampTags, truncateField } from "./field-limits.js";

/** Also reused by fish-clone.ts, whose JSON body has the same `name` cap. */
export const VOICE_NAME_MAX_LEN = 64;

export interface CreateFormInput {
  readonly name: string;
  readonly audio: Blob;
  readonly description: string;
  readonly tags: readonly string[];
  readonly language: string;
}

/** Char/count caps sourced from `services.ttsConfig.voice_*` — kept as a
 *  narrow interface (rather than the full `VoicesHandlerDeps`) so this
 *  parser stays independently testable and has no dependency on the HTTP
 *  handler module. */
export interface CreateFormCaps {
  readonly descriptionMaxLen: number;
  readonly tagMaxLen: number;
  readonly maxTags: number;
}

/**
 * Parses POST /api/v1/voices' multipart body: `name` (required), `audio`
 * (required Blob), `description`, repeated `tags` fields, optional `language`
 * (normalized against the Qwen language list — unsupported/absent drops to
 * `""`). Length-capped fields (name, description, tags) are TRUNCATED to fit
 * rather than rejected — see field-limits.ts. Only structural problems
 * (malformed body, missing name/audio) are errors. All caps are
 * operator-tunable via config.yaml, threaded in through `caps`.
 */
export async function parseCreateForm(
  caps: CreateFormCaps,
  request: Request,
): Promise<Result<CreateFormInput, string>> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, error: "malformed multipart body" };
  }

  const nameRaw = form.get("name");
  const nameTrimmed = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!nameTrimmed) return { ok: false, error: "name is required" };
  const name = truncateField(nameTrimmed, VOICE_NAME_MAX_LEN);

  const audio = form.get("audio");
  if (!(audio instanceof Blob)) return { ok: false, error: "audio file is required" };

  const descriptionRaw = typeof form.get("description") === "string" ? (form.get("description") as string).trim() : "";
  const description = truncateField(descriptionRaw, caps.descriptionMaxLen);

  const rawTags = form
    .getAll("tags")
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  const tags = clampTags(rawTags, caps.maxTags, caps.tagMaxLen);

  const languageRaw = typeof form.get("language") === "string" ? (form.get("language") as string).trim() : "";
  const language = normalizeLanguage(languageRaw);

  return { ok: true, value: { name, audio, description, tags, language } };
}
