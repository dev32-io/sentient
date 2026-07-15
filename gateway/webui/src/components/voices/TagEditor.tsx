// gateway/webui/src/components/voices/TagEditor.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { TextField } from "../settings/primitives/text-field.tsx";
import { Chip } from "../settings/primitives/chip.tsx";

const SUGGESTED_TAGS = ["warm", "calm", "deep", "bright", "family", "kids", "news", "soft"];

// Client-side UX hints only — mirror services.ttsConfig.voice_* caps
// (gateway/config.yaml: voice_max_tags, voice_tag_max_len). The gateway
// re-enforces every cap server-side (see parseCreateForm); these just fail
// fast in the UI. MAX_TAGS is exported so AddVoiceModal can cap Fish's
// suggested tags to the same ceiling before they ever reach this editor.
export const MAX_TAGS = 8;
const TAG_MAX_LEN = 24;

export interface TagEditorProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

/** Free-form + suggested tag picker shared by all three of AddVoiceModal's
 *  metadata editors (record / upload / Fish-clone). */
export function TagEditor({ tags, onChange, disabled = false }: TagEditorProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const atCap = tags.length >= MAX_TAGS;
  // Case-insensitive to match addTag's dedup — a shown chip is always actionable.
  const lowerTags = tags.map((t) => t.toLowerCase());
  const suggestions = SUGGESTED_TAGS.filter((t) => !lowerTags.includes(t.toLowerCase()));

  function addTag(raw: string): void {
    const value = raw.trim().slice(0, TAG_MAX_LEN);
    if (!value || atCap) return;
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) return;
    onChange([...tags, value]);
    setDraft("");
  }

  function removeTag(target: string): void {
    onChange(tags.filter((t) => t !== target));
  }

  return (
    <div class="lst-field">
      <span class="lst-field-l">Tags{atCap ? ` (max ${MAX_TAGS})` : ""}</span>

      {tags.length > 0 && (
        <div class="voices-tag-row">
          {tags.map((t) => (
            <Chip key={t} active onClick={() => removeTag(t)} disabled={disabled}>
              {t} ×
            </Chip>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <div class="voices-tag-row">
          {suggestions.map((t) => (
            <Chip key={t} active={false} onClick={() => addTag(t)} disabled={disabled || atCap}>
              {t}
            </Chip>
          ))}
        </div>
      )}

      <form
        class="voices-rec-row"
        onSubmit={(e: Event) => {
          e.preventDefault();
          addTag(draft);
        }}
      >
        <TextField
          value={draft}
          onChange={(e) => setDraft((e.target as HTMLInputElement).value.slice(0, TAG_MAX_LEN))}
          placeholder={atCap ? `Max ${MAX_TAGS} tags` : "Add a tag, press Enter"}
          fullWidth
          disabled={disabled || atCap}
        />
      </form>
    </div>
  );
}
