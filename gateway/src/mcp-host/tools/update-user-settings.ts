import { audioPrefsPatchSchema } from "@sentient/audio-prefs";
import { z } from "zod";
import { modelProviderSchema, voiceProviderSchema } from "../../profile-store/profile-types.js";
import type { SessionRouter } from "../../session-router.js";
import type { ToolHandler } from "../mcp-server.js";

const patchSchema = z
  .object({
    ttsEnabled: audioPrefsPatchSchema.shape.ttsEnabled,
    channel: audioPrefsPatchSchema.shape.channel,
    voice: z.object({ provider: voiceProviderSchema, id: z.string().min(1) }).optional(),
    model: z.object({ provider: modelProviderSchema, id: z.string().min(1) }).optional(),
  })
  .refine(
    (p) => p.ttsEnabled !== undefined || p.channel !== undefined || p.voice !== undefined || p.model !== undefined,
    { message: "at least one field required" },
  );

export type UpdateUserSettingsPatch = z.output<typeof patchSchema>;

export interface UserSettingsControls {
  updateUserSettings(sessionId: string, userId: string, patch: UpdateUserSettingsPatch): Promise<void>;
}

export interface UpdateUserSettingsDeps {
  controls: UserSettingsControls;
  router: SessionRouter;
}

export function createUpdateUserSettingsTool(deps: UpdateUserSettingsDeps): ToolHandler {
  return {
    def: {
      name: "update_user_settings",
      description:
        "Updates the user's persisted settings. Use to mute/unmute spoken responses (`ttsEnabled`), switch reply channel (`channel`), or change the user's preferred `voice`/`model`. " +
        "All fields are optional; pass only what you want to change. " +
        "`ttsEnabled` and `channel` take effect on the NEXT cycle (current cycle finishes naturally). " +
        "`voice` and `model` take effect on the next session.",
      inputSchema: {
        type: "object",
        properties: {
          ttsEnabled: { type: "boolean" },
          channel: { type: "string", enum: ["voice", "text"] },
          voice: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["local-tts"] },
              id: { type: "string" },
            },
            required: ["provider", "id"],
          },
          model: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["openrouter", "ollama-cloud", "custom"] },
              id: { type: "string" },
            },
            required: ["provider", "id"],
          },
        },
      },
    },
    async run(args, ctx) {
      const parsed = patchSchema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `update_user_settings: invalid input — ${parsed.error.message}`,
            },
          ],
        };
      }
      const sessionId = ctx.userId ? deps.router.findActiveSessionFor(ctx.userId) : null;
      if (!sessionId || !ctx.userId) {
        return {
          isError: true,
          content: [{ type: "text", text: "update_user_settings: no active session for user" }],
        };
      }
      await deps.controls.updateUserSettings(sessionId, ctx.userId, parsed.data);
      const summary = Object.entries(parsed.data)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(", ");
      return { content: [{ type: "text", text: `updated: ${summary}` }] };
    },
  };
}
