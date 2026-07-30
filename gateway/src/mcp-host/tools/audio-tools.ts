import type { ActiveSessionLookup } from "../active-session-lookup.js";
import type { ToolHandler } from "../mcp-server.js";

export interface AudioControls {
  pause(sessionId: string, reason?: string): Promise<void>;
  resume(sessionId: string, reason?: string): Promise<void>;
}

export interface AudioToolsDeps {
  audio: AudioControls;
  router: ActiveSessionLookup;
}

function resolveSession(router: ActiveSessionLookup, userId: string | null): string | null {
  if (!userId) return null;
  return router.findActiveSessionFor(userId);
}

export function createPauseAudioTool(deps: AudioToolsDeps): ToolHandler {
  return {
    def: {
      name: "pause_audio",
      description: "Pauses the current TTS playback on the user's device. Optional reason describes why.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
      },
    },
    async run(args, ctx) {
      const sessionId = resolveSession(deps.router, ctx.userId);
      if (!sessionId) {
        return {
          isError: true,
          content: [{ type: "text", text: "pause_audio: no active session for connection" }],
        };
      }
      await deps.audio.pause(sessionId, typeof args.reason === "string" ? args.reason : undefined);
      return { content: [{ type: "text", text: "audio paused" }] };
    },
  };
}

export function createResumeAudioTool(deps: AudioToolsDeps): ToolHandler {
  return {
    def: {
      name: "resume_audio",
      description: "Resumes previously paused TTS playback.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
      },
    },
    async run(args, ctx) {
      const sessionId = resolveSession(deps.router, ctx.userId);
      if (!sessionId) {
        return {
          isError: true,
          content: [{ type: "text", text: "resume_audio: no active session" }],
        };
      }
      await deps.audio.resume(sessionId, typeof args.reason === "string" ? args.reason : undefined);
      return { content: [{ type: "text", text: "audio resumed" }] };
    },
  };
}
