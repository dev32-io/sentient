import { z } from "zod";

export type WizardStepId = "provider" | "voice" | "secrets" | "bringup" | "admin" | "finish";

// --- Body schemas (lifted from gateway/src/api/handlers/wizard.ts) ---

export const ProviderBody = z.object({
  provider: z.enum(["ollama-cloud", "openrouter", "custom"]),
  api_key: z.string().min(1).optional().nullable(),
  base_url: z.string().url().optional().nullable(),
});
export type ProviderBody = z.infer<typeof ProviderBody>;

// local-tts needs no API key and has a single default voice today — the
// voice step is an acknowledge-and-advance step. Unknown fields (e.g. a
// legacy client still posting {skip:true}) are silently stripped by zod's
// default non-strict object parsing.
export const VoiceBody = z.object({});
export type VoiceBody = z.infer<typeof VoiceBody>;

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

export const SecretsBody = z.object({
  home_assistant: z
    .object({
      url: optionalString,
      local_ip: optionalString,
      observe_token: optionalString,
      mcp_server_token: optionalString,
    })
    .optional(),
  music_assistant: z
    .object({
      url: optionalString,
      local_ip: optionalString,
      token: optionalString,
    })
    .optional(),
});
export type SecretsBody = z.infer<typeof SecretsBody>;

// --- Step chain ---

export interface WizardStepDef {
  id: WizardStepId;
  /** Next step in the chain. null = terminal step (finish). */
  advanceTo: WizardStepId | null;
  /** Previous step user can retreat to. null = no Back button. */
  backTo: WizardStepId | null;
  /** Stepper label. */
  label: string;
}

export const WIZARD_STEPS: ReadonlyArray<WizardStepDef> = [
  { id: "provider", advanceTo: "voice", backTo: null, label: "Provider" },
  { id: "voice", advanceTo: "secrets", backTo: "provider", label: "Voice" },
  { id: "secrets", advanceTo: "bringup", backTo: "voice", label: "Services" },
  { id: "bringup", advanceTo: "admin", backTo: null, label: "Bringup" },
  { id: "admin", advanceTo: "finish", backTo: null, label: "Account" },
  { id: "finish", advanceTo: null, backTo: null, label: "Finish" },
];

// --- Derived transition sets ---

export const VALID_FORWARD: ReadonlySet<string> = new Set(
  WIZARD_STEPS.filter((s) => s.advanceTo !== null).map((s) => `${s.id}→${s.advanceTo}`),
);

export const VALID_REVERSE: ReadonlySet<string> = new Set(
  WIZARD_STEPS.filter((s) => s.backTo !== null).map((s) => `${s.id}→${s.backTo}`),
);

/** Look up a step definition by id. Returns undefined for unknown ids. */
export function findStep(id: WizardStepId): WizardStepDef | undefined {
  return WIZARD_STEPS.find((s) => s.id === id);
}
