/**
 * Shared catalog metadata types.
 *
 * Used by OpenRouter / Ollama catalog fetchers and the My Agent settings
 * UI in Phase 6. Field names are camelCase per project TS rules.
 */

export interface ModelEntry {
  id: string;
  provider: "openrouter" | "ollama-cloud" | "custom";
  name: string;
  description: string;
  contextLength: number;
  pricingPer1mPrompt: number | "included";
  pricingPer1mCompletion: number | "included";
  supportsTools: boolean;
  supportsVision: boolean;
}
