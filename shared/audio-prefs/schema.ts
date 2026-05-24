import { z } from "zod";

// Single source of truth for audio-related preferences. Consumed by:
//   - profile validator (gateway/src/profile-store/profile-types.ts)
//   - update_user_settings MCP tool input
//   - user.preferences.patch WS frame validator
// Keep this file dependency-free except for zod.

export const audioPrefsSchema = z.object({
  ttsEnabled: z.boolean(),
  channel: z.enum(["voice", "text"]),
});

export type AudioPrefs = z.output<typeof audioPrefsSchema>;

export const AUDIO_PREFS_DEFAULT: AudioPrefs = {
  ttsEnabled: true,
  channel: "voice",
};

// Partial form for tool input + WS patch. Allows omitting fields.
export const audioPrefsPatchSchema = audioPrefsSchema.partial();
export type AudioPrefsPatch = z.output<typeof audioPrefsPatchSchema>;
