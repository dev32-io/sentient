import type { Result } from "@sentient/protocol";

const VOICE_NAME_MAX_LEN = 64;

export interface CreateFormInput {
  readonly name: string;
  readonly audio: Blob;
  readonly description: string;
  readonly tags: readonly string[];
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
 * Parses + validates POST /api/v1/voices' multipart body: `name` (required,
 * capped), `audio` (required Blob), `description` (capped), repeated `tags`
 * fields (count- and per-tag-length-capped). All caps are operator-tunable
 * via config.yaml, threaded in through `caps` rather than hardcoded.
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
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > VOICE_NAME_MAX_LEN) return { ok: false, error: `name exceeds ${VOICE_NAME_MAX_LEN} chars` };

  const audio = form.get("audio");
  if (!(audio instanceof Blob)) return { ok: false, error: "audio file is required" };

  const description = typeof form.get("description") === "string" ? (form.get("description") as string).trim() : "";
  if (description.length > caps.descriptionMaxLen) {
    return { ok: false, error: `description exceeds ${caps.descriptionMaxLen} chars` };
  }

  const tags = form
    .getAll("tags")
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tags.length > caps.maxTags) return { ok: false, error: `too many tags (max ${caps.maxTags})` };
  if (tags.some((t) => t.length > caps.tagMaxLen)) return { ok: false, error: `tag exceeds ${caps.tagMaxLen} chars` };

  return { ok: true, value: { name, audio, description, tags } };
}
