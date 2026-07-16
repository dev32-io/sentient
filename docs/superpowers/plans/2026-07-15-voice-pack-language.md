# Voice-Pack Language Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every voice pack a single optional `language` tag (one of Qwen3-TTS's 10 languages), auto-imported when cloning from Fish, filterable in the Voice-Packs grid, and used to pick a language-matched preview greeting.

**Architecture:** A new canonical language list in `@sentient/config` (10 codes + flag/name display) is the single source of truth, imported by gateway + webui; the service just stores the string. `language` threads through the existing `voice.create` / voice-list / preview paths exactly like `description`/`tags` already do — no new subsystems. Preview greetings become a per-language map; the webui passes the pack's language to the preview endpoint, which picks a greeting in that language (the service's `lang_code="auto"` auto-detects it — no new service param).

**Tech Stack:** Python (LocalTTSService), Bun/TypeScript (gateway), Preact/TS (webui), zod (config schema), vitest (webui), `bun test` (gateway), `uv run pytest` (service).

## Global Constraints

- Supported languages are EXACTLY these 10 Qwen3-TTS codes: `zh, en, ja, ko, de, fr, ru, pt, es, it`. Anything else (e.g. Fish's `ar`/`hi`/`th`) is dropped to `""`.
- `language` is a SINGLE string, optional; `""` = unset/any. Never an array.
- NO `instruct` field anywhere — explicitly out of scope (instruct has no effect on ref-audio clones).
- The canonical language list lives ONCE in `@sentient/config` (`.claude/rules/typescript.md`: shared types in `shared/`, never duplicate). The service keeps a tiny Python mirror (TS can't be imported into Python).
- Test-lean (`.claude/rules/testing.md`): add tests ONLY for wire/protocol contracts (the new `language` field in `voice.create` parse, gateway create-form validation, voice-list parse, fish-clone body parse, preview greeting-pick). Presentational webui (dropdown, filter, tile badge) is verified by E2E, NOT unit tests.
- Files ≤300 lines / functions ≤40 (service Python + gateway/webui TS per `.claude/rules/clean-code.md`). Tagged loggers; never log voice name/description/tag CONTENT — ids/lengths/counts only.
- Every value stays operator-tunable in config where applicable; preview greetings live in `gateway/config.yaml`, not source.
- Gateway tests use `bun test` native (NOT `bunx vitest`); webui uses vitest; service uses `.venv/bin/python -m pytest` (a `rtk` hook intercepts `uv run pytest` in this env).

---

### Task 1: Canonical language list in `@sentient/config`

**Files:**
- Create: `shared/config/src/languages.ts`
- Modify: `shared/config/src/index.ts` (re-export)
- Test: `shared/config/src/languages.test.ts`

**Interfaces:**
- Produces: `SUPPORTED_LANGUAGES: readonly string[]` (the 10 codes); `LANGUAGE_DISPLAY: Record<string, { flag: string; name: string }>`; `isSupportedLanguage(code: string): boolean`; `normalizeLanguage(code: string): string` (lowercased code if supported, else `""`).

- [ ] **Step 1: Write the failing test**

```ts
// shared/config/src/languages.test.ts
import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES, isSupportedLanguage, normalizeLanguage, LANGUAGE_DISPLAY } from "./languages.ts";

describe("languages", () => {
  it("has exactly the 10 Qwen languages", () => {
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(["de","en","es","fr","it","ja","ko","pt","ru","zh"]);
  });
  it("isSupportedLanguage is case-insensitive and rejects unknown", () => {
    expect(isSupportedLanguage("ZH")).toBe(true);
    expect(isSupportedLanguage("ar")).toBe(false);
    expect(isSupportedLanguage("")).toBe(false);
  });
  it("normalizeLanguage lowercases supported, empties unknown", () => {
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("th")).toBe("");
    expect(normalizeLanguage("")).toBe("");
  });
  it("every supported code has a display entry", () => {
    for (const c of SUPPORTED_LANGUAGES) expect(LANGUAGE_DISPLAY[c]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `cd shared/config && bunx vitest run src/languages.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// shared/config/src/languages.ts
//
// Canonical list of the languages Qwen3-TTS (the local-tts engine) supports.
// SINGLE SOURCE OF TRUTH — imported by the gateway (validation) and webui
// (dropdown + filter + tile badge). The service keeps a tiny Python mirror
// (see LocalTTSService/src/local_tts/languages.py) since TS can't cross into
// Python. Fish Audio returns codes outside this set (ar/hi/th/…) — those are
// dropped to "" on import (normalizeLanguage).

export interface LanguageDisplay {
  readonly flag: string;
  readonly name: string;
}

export const LANGUAGE_DISPLAY: Record<string, LanguageDisplay> = {
  zh: { flag: "🇨🇳", name: "Chinese" },
  en: { flag: "🇺🇸", name: "English" },
  ja: { flag: "🇯🇵", name: "Japanese" },
  ko: { flag: "🇰🇷", name: "Korean" },
  de: { flag: "🇩🇪", name: "German" },
  fr: { flag: "🇫🇷", name: "French" },
  ru: { flag: "🇷🇺", name: "Russian" },
  pt: { flag: "🇵🇹", name: "Portuguese" },
  es: { flag: "🇪🇸", name: "Spanish" },
  it: { flag: "🇮🇹", name: "Italian" },
};

export const SUPPORTED_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_DISPLAY);

export function isSupportedLanguage(code: string): boolean {
  return code !== "" && Object.hasOwn(LANGUAGE_DISPLAY, code.toLowerCase());
}

/** Lowercased code if supported, else "" (drops Fish's unsupported langs). */
export function normalizeLanguage(code: string): string {
  const c = code.toLowerCase();
  return isSupportedLanguage(c) ? c : "";
}
```

Then add to `shared/config/src/index.ts` (match the existing re-export style in that file — likely `export * from "./languages.ts";`).

- [ ] **Step 4: Run test to verify it passes** — same command → PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
source scripts/env.sh && bun run --filter '@sentient/config' typecheck
git add shared/config/src/languages.ts shared/config/src/languages.test.ts shared/config/src/index.ts
git commit -m "feat(config): canonical Qwen language list (10 langs + display)"
```

---

### Task 2: Service — `language` on the voice pack (store + read + protocol)

**Files:**
- Create: `capabilityServices/LocalTTSService/src/local_tts/languages.py` (Python mirror)
- Modify: `.../src/local_tts/pack_meta.py:39-46` (read), `.../voice_store.py:133-135` + `:184-187` (create + meta dict), `.../wire_protocol.py:84-90` + `:162-167` (message + parse), `.../connection_session.py:170` (create call), `.../CONTRACT.md` (§4.1 voice.create, §4.2 voice.list)
- Test: `.../tests/test_wire_protocol.py` (voice.create with language), `.../tests/test_voice_store.py` (create→list roundtrips language)

**Interfaces:**
- Consumes: nothing from Task 1 (Python mirror).
- Produces: `VoiceCreateMessage.language: str` (default `""`); `voice_store.create(..., language: str = "")`; `read_pack_meta(...)` dict now includes `"language"`; the `voice.list` output dict includes `"language"`.

- [ ] **Step 1: Write the Python language mirror** (used only if the service ever validates; store-only for now, but keep the list for parity/logging):

```python
# capabilityServices/LocalTTSService/src/local_tts/languages.py
"""Python mirror of the canonical Qwen3-TTS language codes.

The TS source of truth is shared/config/src/languages.ts. The service only
STORES the language string (the gateway validates on the way in), so this is
kept minimal — a frozenset for a defensive membership check + docs parity.
"""

SUPPORTED_LANGUAGES: frozenset[str] = frozenset(
    {"zh", "en", "ja", "ko", "de", "fr", "ru", "pt", "es", "it"}
)
```

- [ ] **Step 2: Write the failing wire-protocol test**

```python
# add to tests/test_wire_protocol.py
def test_voice_create_parses_optional_language():
    msg = parse_client_message('{"type":"voice.create","name":"Nova","language":"zh"}')
    assert msg.name == "Nova"
    assert msg.language == "zh"

def test_voice_create_language_defaults_empty():
    msg = parse_client_message('{"type":"voice.create","name":"Nova"}')
    assert msg.language == ""
```

Run: `cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest tests/test_wire_protocol.py -q` → FAIL (`language` attr missing).

- [ ] **Step 3: Implement — `wire_protocol.py`**

`VoiceCreateMessage` (add field after `tags`):
```python
@dataclass
class VoiceCreateMessage:
    """Start a voice-pack upload; the next binary frame is the reference wav."""

    name: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    language: str = ""
```
`parse_client_message` voice.create branch (add `language`):
```python
    if kind == _TYPE_VOICE_CREATE:
        return VoiceCreateMessage(
            name=_require_str(parsed, "name", kind),
            description=_optional_str(parsed, "description"),
            tags=_optional_str_list(parsed, "tags", kind),
            language=_optional_str(parsed, "language"),
        )
```

- [ ] **Step 4: Implement — `pack_meta.py`** (`read_pack_meta` return dict, add after `tags`):
```python
        "language": meta.get("language", ""),
```

- [ ] **Step 5: Implement — `voice_store.py`** (`create` signature + `_build_pack` signature + meta dict):
```python
    def create(
        self, ref_wav: np.ndarray, sr: int, name: str, description: str = "",
        tags: list[str] | None = None, language: str = "",
    ) -> dict:
```
Thread it into the `_build_pack(...)` call (add `language` as the last arg), update `_build_pack` signature to accept `language: str`, and add to the meta dict written in `_build_pack`:
```python
            meta = {
                "name": name, "description": description, "tags": list(tags or []),
                "language": language,
                "createdAt": created_at, "refDurationMs": ref_duration_ms,
            }
```

- [ ] **Step 6: Implement — `connection_session.py`** (`_create_voice`, the `voice_store.create` to_thread call, add `pending.language`):
```python
                result = await asyncio.to_thread(
                    self._voice_store.create, array, sr, pending.name,
                    pending.description, pending.tags, pending.language,
                )
```

- [ ] **Step 7: Add the voice_store roundtrip test**

```python
# add to tests/test_voice_store.py — reuse the existing tmp-store fixture pattern
def test_create_stores_and_lists_language(tmp_path):
    store = VoiceStore(_StubEngine(), tmp_path / "voices")
    ref = np.zeros(int(24000 * 4), dtype=np.float32)  # >3s
    store.create(ref, 24000, "Nova", language="ja")
    listed = [v for v in store.list() if v.get("source") == "user"]
    assert listed and listed[0]["language"] == "ja"
```
(If `_StubEngine`/imports differ, match the file's existing test setup.)

- [ ] **Step 8: Update `CONTRACT.md`** — §4.1 (`voice.create`): document optional `language` field ("one of zh/en/ja/ko/de/fr/ru/pt/es/it, or omitted; the service stores it verbatim, the gateway validates"). §4.2 (`voice.list`): each voice now carries `language` (`""` when unset).

- [ ] **Step 9: Run tests + commit**

```bash
cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest -q   # expect all green (+3 new)
git add -A capabilityServices/LocalTTSService
git commit -m "feat(tts): store optional language on voice packs (voice.create + list)"
```

---

### Task 3: Gateway — `language` on the create path

**Files:**
- Modify: `gateway/src/api/handlers/voices-create-form.ts:6-11` + `:29-62` (input + parse/validate), `gateway/src/providers/tts/local-tts-protocol.ts:119` (`voiceCreateMsg`), `gateway/src/providers/tts/voice-mgmt-client.ts:174-190` (`createVoice`), `gateway/src/api/handlers/voices.ts:181-188` (thread through)
- Test: `gateway/src/api/handlers/voices-create-form.test.ts` (or the existing create-form test), `gateway/src/providers/tts/local-tts-protocol.test.ts` (voiceCreateMsg)

**Interfaces:**
- Consumes: `normalizeLanguage` from `@sentient/config` (Task 1).
- Produces: `CreateFormInput.language: string`; `voiceCreateMsg(name, description, tags, language)`; `createVoice(cfg, name, audio, signal, description, tags, language)`.

- [ ] **Step 1: Failing test — create-form parses + normalizes language**

```ts
// gateway/src/api/handlers/voices-create-form.test.ts (create or extend)
import { describe, expect, it } from "bun:test";
import { parseCreateForm } from "./voices-create-form.ts";

const caps = { descriptionMaxLen: 240, tagMaxLen: 24, maxTags: 8 };
function form(fields: Record<string, string>, withAudio = true): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (withAudio) fd.set("audio", new Blob([new Uint8Array([1, 2, 3])]), "r.wav");
  return new Request("http://x/api/v1/voices", { method: "POST", body: fd });
}

describe("parseCreateForm language", () => {
  it("keeps a supported language (case-insensitive)", async () => {
    const r = await parseCreateForm(caps, form({ name: "Nova", language: "ZH" }));
    expect(r.ok && r.value.language).toBe("zh");
  });
  it("drops an unsupported language to empty", async () => {
    const r = await parseCreateForm(caps, form({ name: "Nova", language: "th" }));
    expect(r.ok && r.value.language).toBe("");
  });
  it("defaults to empty when absent", async () => {
    const r = await parseCreateForm(caps, form({ name: "Nova" }));
    expect(r.ok && r.value.language).toBe("");
  });
});
```

Run: `source scripts/env.sh && cd gateway/src && bun test api/handlers/voices-create-form.test.ts` → FAIL.

- [ ] **Step 2: Implement — `voices-create-form.ts`**

Add import at top: `import { normalizeLanguage } from "@sentient/config";`
Add to `CreateFormInput`: `readonly language: string;`
In `parseCreateForm`, before the final `return { ok: true, ... }`:
```ts
  const languageRaw = typeof form.get("language") === "string" ? (form.get("language") as string).trim() : "";
  const language = normalizeLanguage(languageRaw);
```
Return: `return { ok: true, value: { name, audio, description, tags, language } };`

- [ ] **Step 3: Implement — `voiceCreateMsg`** (`local-tts-protocol.ts`)
```ts
export function voiceCreateMsg(name: string, description: string, tags: readonly string[], language: string): string {
  return JSON.stringify({ type: CLIENT_MSG_TYPE.VOICE_CREATE, name, description, tags, language });
}
```
Update its existing test (`local-tts-protocol.test.ts:61-62`) to pass a 4th arg and assert `parsed.language`.

- [ ] **Step 4: Implement — `createVoice`** (`voice-mgmt-client.ts`): add `language: string` param (after `tags`), pass to `voiceCreateMsg(name, description, tags, language)`. Update its test (`voice-mgmt-client.test.ts:71`) to pass + assert language on the sent frame.

- [ ] **Step 5: Implement — `voices.ts` `handleVoicesPost`** — thread `parsed.value.language` into the `createVoice(...)` call (add as the last arg).

- [ ] **Step 6: Run tests + commit**
```bash
source scripts/env.sh && cd gateway/src && bun test api/handlers/voices-create-form.test.ts providers/tts/local-tts-protocol.test.ts providers/tts/voice-mgmt-client.test.ts
git add -A gateway/src && git commit -m "feat(gateway): accept + validate voice language on create"
```

---

### Task 4: Gateway — `language` on the list-read path

**Files:**
- Modify: `gateway/src/providers/tts/local-tts-protocol.ts:47-54` (`LocalTtsVoiceInfo`) + `parseVoiceInfo` (~L240)
- Test: `gateway/src/providers/tts/local-tts-protocol.test.ts` (voice-list parse)

**Interfaces:**
- Produces: `LocalTtsVoiceInfo.language: string`. `handleVoicesGet` already passes `result.value.voices` straight through, so no handler change — the field flows to the API response automatically once parsed.

- [ ] **Step 1: Failing test** — parse a `voice.list` frame containing `language`:
```ts
it("parseServerFrame reads language on voice.list entries", () => {
  const frame = parseServerFrame(JSON.stringify({
    type: "voice.list",
    voices: [{ voiceId: "v1", name: "Nova", description: "", tags: [], source: "user", createdAt: 1, refDurationMs: 1000, language: "es" }],
  }));
  expect(frame.kind === "voiceList" && frame.voices[0].language).toBe("es");
});
```
(Match the actual server-frame parse entry point name used in the existing test file.)

Run the protocol test file → FAIL.

- [ ] **Step 2: Implement** — add `readonly language: string;` to `LocalTtsVoiceInfo` (after `refDurationMs`); in `parseVoiceInfo`, read it: `language: asString(record.language)` (mirror how `description` is read; default `""` when absent).

- [ ] **Step 3: Run test + commit**
```bash
source scripts/env.sh && cd gateway/src && bun test providers/tts/local-tts-protocol.test.ts
git add -A gateway/src && git commit -m "feat(gateway): parse voice language on the list frame"
```

---

### Task 5: Gateway — Fish clone imports language

**Files:**
- Modify: `gateway/src/api/handlers/fish/fish-clone.ts:90-94` (`CloneBody`), `:226-248` (`parseBody`), `:207` (`createAndActivate` → `createVoice`)
- Test: `gateway/src/api/handlers/fish/fish-clone.test.ts` (parseBody language)

**Interfaces:**
- Consumes: `normalizeLanguage` from `@sentient/config`; `createVoice(..., language)` (Task 3).
- Produces: `CloneBody.language: string`. The webui sends the Fish-derived language in the JSON body (Task 8); `parseBody` validates it. (The gateway trusts the client's language here just like name/description/tags — it's already validated client-side + re-normalized server-side.)

- [ ] **Step 1: Failing test**
```ts
it("parseBody keeps a supported language and drops an unsupported one", async () => {
  const mk = (lang: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify({ name: "V", language: lang }) });
  const caps = { descriptionMaxLen: 240, tagMaxLen: 24, maxTags: 8 } as any;
  expect((await parseBody(caps, mk("ja"))).ok && (await parseBody(caps, mk("ja"))).value.language).toBe("ja");
  expect((await parseBody(caps, mk("th"))).ok && (await parseBody(caps, mk("th"))).value.language).toBe("");
});
```
(Export `parseBody` if not already, or test via the public handler; match the file's existing test style + FishCloneDeps caps shape.)

- [ ] **Step 2: Implement** — import `normalizeLanguage`; add `language: string;` to `CloneBody`; in `parseBody`, after tags:
```ts
  const language = normalizeLanguage(typeof input.language === "string" ? input.language.trim() : "");
```
return `{ ok: true, value: { name, description, tags: tags.value, language } }`. In `createAndActivate`, pass `body.language` as the last arg to `createVoice(...)`.

- [ ] **Step 3: Run test + commit**
```bash
source scripts/env.sh && cd gateway/src && bun test api/handlers/fish/fish-clone.test.ts
git add -A gateway/src && git commit -m "feat(gateway): import Fish voice language on clone"
```

---

### Task 6: Gateway — per-language preview greetings

**Files:**
- Modify: `gateway/config.yaml:135-142` (`preview_greetings` → map), `shared/config/src/schema.ts:99` (`preview_greetings` schema), `gateway/src/api/handlers/voices-preview.ts` (greeting pick by language), `gateway/src/api/handlers/voices.ts` (`VoicesHandlerDeps.previewGreetings` type), `gateway/src/server.ts:182` (wiring unchanged if type flows)
- Create: `gateway/src/api/handlers/preview-greeting.ts` (pick helper) + `.test.ts`

**Interfaces:**
- Consumes: `isSupportedLanguage` from `@sentient/config`.
- Produces: `PreviewGreetings = Record<string, string[]>`; `pickPreviewGreeting(greetings: PreviewGreetings, lang: string): string`. The webui passes `?lang=<code>` to `POST /api/v1/voices/:id/preview` (Task 7).

- [ ] **Step 1: Failing test — the pick helper**
```ts
// gateway/src/api/handlers/preview-greeting.test.ts
import { describe, expect, it } from "bun:test";
import { pickPreviewGreeting } from "./preview-greeting.ts";

const G = { en: ["hi-en"], zh: ["你好-zh"] };
describe("pickPreviewGreeting", () => {
  it("uses the requested language's list", () => { expect(pickPreviewGreeting(G, "zh")).toBe("你好-zh"); });
  it("falls back to English for unset/unknown/absent lang", () => {
    expect(pickPreviewGreeting(G, "")).toBe("hi-en");
    expect(pickPreviewGreeting(G, "th")).toBe("hi-en");
    expect(pickPreviewGreeting({ zh: ["只有中文"] }, "th")).toBe("只有中文"); // no en → any available
  });
});
```

- [ ] **Step 2: Implement the helper**
```ts
// gateway/src/api/handlers/preview-greeting.ts
import { isSupportedLanguage } from "@sentient/config";

export type PreviewGreetings = Record<string, readonly string[]>;

const FALLBACK = "Hello.";

/** Pick a random greeting in `lang` (a supported code), else English, else
 *  any non-empty list, else a bare "Hello." — never throws on empty config. */
export function pickPreviewGreeting(greetings: PreviewGreetings, lang: string): string {
  const key = isSupportedLanguage(lang) ? lang.toLowerCase() : "en";
  const list = (greetings[key]?.length ? greetings[key] : greetings.en) ?? Object.values(greetings).find((l) => l.length);
  if (!list || list.length === 0) return FALLBACK;
  return list[Math.floor(Math.random() * list.length)] ?? FALLBACK;
}
```

- [ ] **Step 3: Config — `gateway/config.yaml`** replace the flat `preview_greetings` list with a per-language map (short ~2s greetings, 2 each):
```yaml
  # Preview greetings by language — one is chosen at random per Play preview and
  # synthesized live in the target voice, in the voice pack's language (the
  # service auto-detects the language from the text). Keep each short (~2s).
  preview_greetings:
    en:
      - "Hi, I'm your family's Sentient assistant. How can I help?"
      - "Hello there — Sentient here, ready when you are."
    zh:
      - "你好，我是你们家的 Sentient 助手，有什么可以帮忙的吗？"
      - "嗨，我是 Sentient，随时为你服务。"
    ja:
      - "こんにちは、ご家族の Sentient アシスタントです。ご用件は何でしょう？"
      - "やあ、Sentient です。いつでもお手伝いします。"
    ko:
      - "안녕하세요, 가족의 Sentient 비서예요. 무엇을 도와드릴까요?"
      - "안녕하세요, Sentient입니다. 언제든 도와드릴게요."
    de:
      - "Hallo, ich bin euer Sentient-Assistent für die Familie. Wie kann ich helfen?"
      - "Hi, hier ist Sentient — bereit, wenn du es bist."
    fr:
      - "Bonjour, je suis l'assistant Sentient de votre famille. Comment puis-je aider ?"
      - "Salut, ici Sentient — prêt quand vous voulez."
    ru:
      - "Здравствуйте, я — ваш семейный ассистент Sentient. Чем могу помочь?"
      - "Привет, это Sentient. Готов помочь в любой момент."
    pt:
      - "Olá, sou o assistente Sentient da sua família. Como posso ajudar?"
      - "Oi, aqui é o Sentient — pronto quando você estiver."
    es:
      - "Hola, soy el asistente Sentient de tu familia. ¿En qué puedo ayudarte?"
      - "Hola, soy Sentient — listo cuando quieras."
    it:
      - "Ciao, sono l'assistente Sentient della tua famiglia. Come posso aiutarti?"
      - "Ciao, sono Sentient — pronto quando vuoi."
```

- [ ] **Step 4: Schema — `shared/config/src/schema.ts`** replace the `preview_greetings: z.array(z.string()).default([...])` with a language-map schema:
```ts
  preview_greetings: z
    .record(z.string(), z.array(z.string()))
    .default({ en: ["Hi, I'm your family's Sentient assistant. How can I help?"] }),
```
(Keep the existing English default entry text so a bare config still previews.)

- [ ] **Step 5: Handler — `voices-preview.ts`** — accept the language, use the helper:
```ts
export async function handleVoicesPreview(
  deps: VoicesHandlerDeps,
  voiceId: string,
  lang: string,
  signal: AbortSignal,
): Promise<Response> {
  const greeting = pickPreviewGreeting(deps.previewGreetings, lang);
  log.info("preview.request", { voiceId, lang: lang || "(unset)", greetingLen: greeting.length });
  // …unchanged synthesizePreview + pcmToWav…
}
```
Update `VoicesHandlerDeps.previewGreetings` type in `voices.ts` to `PreviewGreetings` (import from `preview-greeting.ts`), and the router call site that invokes `handleVoicesPreview` to read the language off the request URL: `const lang = new URL(request.url).searchParams.get("lang") ?? "";` and pass it. `server.ts:182` (`previewGreetings: services.ttsConfig.preview_greetings`) is unchanged — the config type now IS the map.

- [ ] **Step 6: Run tests + commit**
```bash
source scripts/env.sh && cd gateway/src && bun test api/handlers/preview-greeting.test.ts
cd /Users/kevinye/Development/sentient && bun run --filter '@sentient/config' test
git add -A gateway/config.yaml shared/config/src/schema.ts gateway/src && git commit -m "feat(gateway): per-language preview greetings"
```
Also mirror the config change into the running host config: edit `~/.sentient/gateway/config/config.yaml`'s `preview_greetings` to the same map shape (edit in place — never overwrite from the template).

---

### Task 7: Webui — `language` through the API layer

**Files:**
- Modify: `gateway/webui/src/services/voices-api.ts:14-23` (`VoiceSummary`), `:56-64` + `:81-87` (`createVoice`), `previewVoice` (add `lang`), `gateway/webui/src/services/fish-api.ts` (`cloneFromFish` add language)
- Test: none (thin fetch layer — `.claude/rules/testing.md`: DI/plumbing not tested; the wire contract is covered gateway-side + by E2E).

**Interfaces:**
- Produces: `VoiceSummary.language: string`; `createVoice(token, name, audio, description, tags, language)`; `previewVoice(token, voiceId, lang)`; `cloneFromFish(token, { fishVoiceId, name, description, tags, language })`.

- [ ] **Step 1:** `VoiceSummary` — add `language: string;` (after `tags`).
- [ ] **Step 2:** `createVoice` — add `language: string` param; `form.set("language", language);` before the audio append. Update the `VoicesApi` interface signature + JSDoc.
- [ ] **Step 3:** `previewVoice` — add `lang: string` param; append `?lang=<encodeURIComponent(lang)>` to the preview URL.
- [ ] **Step 4:** `fish-api.ts` `cloneFromFish` — add `language` to the request body object it POSTs (the `FishVoiceEntry` already carries `languages`).
- [ ] **Step 5: Typecheck + commit**
```bash
source scripts/env.sh && bun run --filter '@sentient/webui' typecheck
git add -A gateway/webui/src/services && git commit -m "feat(webui): thread voice language through the voices/fish API layer"
```

---

### Task 8: Webui — language input in the Add-voice modal + Fish prefill

**Files:**
- Modify: `gateway/webui/src/components/voices/AddVoiceModal.tsx:49-55` (props), `:67-73` (state), `:114-119` (`handleFishPick`), `:203-230` (metadata editor — add the Select), and the `onCreate`/`onCloneFromFish` call sites; `gateway/webui/src/components/voices/fish/FishClonePanel.tsx:48-52` + `:194-197` (`suggestedLanguage`); `gateway/webui/src/components/voices/VoicesPanel.tsx` (pass `language` to `createVoice`/`cloneFromFish`)
- Test: none (presentational — E2E in Task 10).

**Interfaces:**
- Consumes: `LANGUAGE_DISPLAY`, `SUPPORTED_LANGUAGES`, `normalizeLanguage` from `@sentient/config` (Task 1); `createVoice(..., language)` / `cloneFromFish(..., language)` (Task 7); `FishClonePickInput.suggestedLanguage`.

- [ ] **Step 1:** In `FishClonePanel.tsx`, extend `FishClonePickInput` with `suggestedLanguage: string` and set it at the `onClone` call (L194-197) to `normalizeLanguage(v.languages[0] ?? "")` (import `normalizeLanguage`).
- [ ] **Step 2:** In `AddVoiceModal.tsx`: add `language` local state (`useState("")`); reset it in the same effect that resets name/description/tags. Extend `onCreate` prop to `(audio, name, description, tags, language)` and `onCloneFromFish` to `(fishVoiceId, name, description, tags, language)`. In `handleFishPick` (L114-119), set `setLanguage(pick.suggestedLanguage)` alongside name/tags.
- [ ] **Step 3:** In the metadata editor JSX (L203-230, next to Description/`TagEditor`), add a single-select language dropdown. Reuse the same `Select` primitive the Fish toolbar uses (`gateway/webui/src/components/voices/fish/fish-toolbar.tsx:45-73` shows the pattern) and build options from the shared list:
```tsx
import { LANGUAGE_DISPLAY, SUPPORTED_LANGUAGES } from "@sentient/config";
// …
const langOptions = [
  { value: "", label: "No language" },
  ...SUPPORTED_LANGUAGES.map((c) => ({ value: c, label: `${LANGUAGE_DISPLAY[c].flag} ${LANGUAGE_DISPLAY[c].name}` })),
];
// in JSX:
<label class="field">
  <span class="field-label">Language</span>
  <Select value={language} onChange={setLanguage} options={langOptions} />
</label>
```
(Match the modal's existing field markup/classes.)
- [ ] **Step 4:** Wire the create + clone submit paths in `AddVoiceModal` to pass `language` to `onCreate`/`onCloneFromFish`; in `VoicesPanel.tsx` update those handlers to pass `language` into `api.createVoice(...)` / `api.cloneFromFish(...)`.
- [ ] **Step 5: Typecheck + commit**
```bash
source scripts/env.sh && bun run --filter '@sentient/webui' typecheck && bun run --filter '@sentient/webui' test
git add -A gateway/webui/src && git commit -m "feat(webui): language picker in add-voice modal + Fish prefill"
```

---

### Task 9: Webui — language filter in the Voice-Packs grid + tile badge

**Files:**
- Modify: `gateway/webui/src/components/voices/voice-filter.ts:6-29` (state + filter + options), `VoiceFilterBar.tsx:14-45` (language Select), `VoicesPanel.tsx:39-107` (state + wiring), `VoicePackTile.tsx:23-30` (flag badge), `gateway/webui/src/components/voices/fish/fish-langs.ts` (reduce to import shared)
- Test: `gateway/webui/src/components/voices/voice-filter.test.ts` (filterPacks by language — this is pure logic, worth a unit test)

**Interfaces:**
- Consumes: `LANGUAGE_DISPLAY` from `@sentient/config`; `VoiceSummary.language` (Task 7).
- Produces: `VoiceFilterState.language: string`; `deriveLanguageOptions(packs): string[]`; `filterPacks` respects `language`.

- [ ] **Step 1: Failing test**
```ts
// gateway/webui/src/components/voices/voice-filter.test.ts (extend if it exists)
import { describe, expect, it } from "vitest";
import { filterPacks, deriveLanguageOptions } from "./voice-filter.ts";
const pk = (o: Partial<any>) => ({ voiceId: "x", name: "N", description: "", tags: [], source: "user", createdAt: 0, refDurationMs: 0, language: "", ...o });
describe("voice-filter language", () => {
  it("filters by exact language", () => {
    const packs = [pk({ language: "zh" }), pk({ language: "en" }), pk({ language: "" })];
    expect(filterPacks(packs as any, { q: "", source: "all", tags: [], language: "zh" }).length).toBe(1);
  });
  it("language '' means no language filter", () => {
    const packs = [pk({ language: "zh" }), pk({ language: "en" })];
    expect(filterPacks(packs as any, { q: "", source: "all", tags: [], language: "" }).length).toBe(2);
  });
  it("deriveLanguageOptions is the sorted unique non-empty set", () => {
    expect(deriveLanguageOptions([pk({ language: "zh" }), pk({ language: "en" }), pk({ language: "" }), pk({ language: "zh" })] as any)).toEqual(["en", "zh"]);
  });
});
```
Run: `source scripts/env.sh && bun run --filter '@sentient/webui' test -- voice-filter` → FAIL.

- [ ] **Step 2: Implement — `voice-filter.ts`** add `language: string;` to `VoiceFilterState`; in `filterPacks` add (before the search check): `if (f.language !== "" && p.language !== f.language) return false;`. Add:
```ts
export function deriveLanguageOptions(packs: VoiceSummary[]): string[] {
  const set = new Set<string>();
  for (const p of packs) if (p.language) set.add(p.language);
  return [...set].sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 3: Implement — `VoiceFilterBar.tsx`** add `language`, `allLanguages`, `onLanguage` props; render a `Select` (same as the Fish toolbar) in the top row next to the `Segmented` source control, options `[{value:"",label:"All languages"}, ...allLanguages.map(c => ({value:c, label:`${LANGUAGE_DISPLAY[c].flag} ${LANGUAGE_DISPLAY[c].name}`}))]`.

- [ ] **Step 4: Implement — `VoicesPanel.tsx`** add `language` state (`useState("")`); include it in the `filterPacks(all, { q, source, tags, language })` arg; compute `allLanguages = deriveLanguageOptions(all)`; pass `language`/`allLanguages`/`onLanguage` to `<VoiceFilterBar>`.

- [ ] **Step 5: Implement — `VoicePackTile.tsx`** render a small language flag badge in the tile head when `pack.language` is set: `{pack.language && <span class="lang-badge" title={LANGUAGE_DISPLAY[pack.language]?.name}>{LANGUAGE_DISPLAY[pack.language]?.flag}</span>}` (match tile styling; add a minimal CSS rule if needed).

- [ ] **Step 6: Reduce `fish/fish-langs.ts`** to re-export the shared display so there's ONE map: replace `LANG_MAP` + `langDisplay` internals with `import { LANGUAGE_DISPLAY } from "@sentient/config"` and keep `langDisplay(code)` returning `LANGUAGE_DISPLAY[code.toLowerCase()] ?? { flag: "🌐", name: code.toUpperCase() }`. (Fish may still return unsupported codes for its browse list — the `🌐` fallback keeps those rendering in the Fish grid; only the voice-pack side is constrained to the 10.)

- [ ] **Step 7: Run tests + typecheck + commit**
```bash
source scripts/env.sh && bun run --filter '@sentient/webui' test -- voice-filter && bun run --filter '@sentient/webui' typecheck
git add -A gateway/webui/src && git commit -m "feat(webui): language filter in Voice-Packs grid + tile badge"
```

---

### Task 10: E2E + full gate

**Files:** Modify `agents/docs/testing-knowledge.md` (append the reusable cases). No product code.

**E2E matrix (inline — run against the LOCAL stack: gateway :8888 rebuilt/hot-copied webui, native local-tts service running):**

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|------|----------|-----------|--------|-----------------------|--------------------|
| lang-manual-create | desktop 1280×900 | Add-voice modal, Record/Upload a >3s clip | pick a language in the new dropdown, name it, create | pack appears in "Yours" with the language flag badge | gateway `create.request`; service `voice_store.create … language=<code>` |
| lang-fish-import | desktop | Clone-from-Fish tab, pick a Chinese Fish voice | Clone | new pack's language prefilled = zh, badge shows 🇨🇳 | `[api:fish:clone] clone.create.request`; created pack `language=zh` |
| lang-fish-unsupported | desktop | Clone a Fish voice whose only lang is outside the 10 (e.g. `ar`) | Clone | pack created with NO language badge (dropped to "") | clone succeeds; `language=""` |
| lang-filter | desktop | ≥2 packs with different languages | pick a language in the Voice-Packs filter Select | grid narrows to that language only; clearing shows all | (client-side; assert grid count) |
| preview-lang | desktop | a zh-tagged pack | click its Play preview | Mandarin greeting audio plays (auditioned) | gateway `preview.request … lang=zh`; service synth, `local_tts.*`, no error |
| preview-unset | desktop | a pack with no language | Play preview | English greeting plays | `preview.request … lang=(unset)` |
| lang-responsive | mobile 390×844 | Voices panel | open filter + add-voice modal | language Select + dropdown usable, no overflow | (visual) |

- [ ] **Step 1:** Rebuild the webui + hot-copy into the running gateway container (per this session's established flow): `cd gateway/webui && bun run build && docker cp dist/. sentient-gateway:/app/webui/dist/`. Restart the local-tts service if the preview config changed (`launchctl bootout … local-tts` → wait 5s → `bootstrap`), confirm `:8771/health`.
- [ ] **Step 2:** Drive every matrix row with Playwright MCP at https://localhost:8888 (PIN gate — the operator supplies the PIN or runs the audio-audition rows). Capture screenshots + the gateway/service log trail. Audition `preview-lang` (Mandarin) + confirm each row's log trail (no unexpected WARN/ERROR).
- [ ] **Step 3:** Append the reusable cases (`lang-manual-create`, `lang-fish-import`, `lang-filter`, `preview-lang`) to `agents/docs/testing-knowledge.md` under the voices section.
- [ ] **Step 4: Full gate**
```bash
source scripts/env.sh && bun run ci           # lint + typecheck + all TS tests
cd capabilityServices/LocalTTSService && .venv/bin/python -m pytest -q   # + -m live on-host
```
- [ ] **Step 5: Commit**
```bash
git add agents/docs/testing-knowledge.md
git commit -m "test(voices): e2e — voice-pack language metadata, filter, multilingual preview"
```

---

## Self-Review

- **Coverage:** (A) shared list = T1; (B) service store/read/protocol = T2; (C) gateway create = T3, list-read = T4, fish-clone import = T5; (D) webui api = T7, modal input+prefill = T8, filter+tile = T9; (E) preview = T6; (F) E2E = T10. All requirements mapped.
- **Type consistency:** `language: string` (single, `""` default) everywhere — `VoiceCreateMessage`/`voice_store.create`/`CreateFormInput`/`voiceCreateMsg`/`createVoice`/`LocalTtsVoiceInfo`/`VoiceSummary`/`CloneBody`/`VoiceFilterState` all use the same name+type. `voiceCreateMsg`/`createVoice` gain `language` as the trailing arg consistently (T3), consumed by T5's clone call. `previewGreetings` becomes `Record<string,string[]>` in both the schema (T6-S4) and the handler deps (T6-S5).
- **No instruct** anywhere. **No placeholders** — every step has concrete code or an exact command.
- **Ordering:** T1 (shared) → T2 (service) → T3/T4 (gateway create/list) → T5 (clone) → T6 (preview) → T7 (webui api) → T8/T9 (webui UI) → T10 (E2E). Each task is independently testable + committable.
