import type { ProductToolMetadata } from "@sentient/config";
import type { ImpactTier } from "@sentient/protocol";
import { MUSIC_TOOL_SETTINGS } from "../tools/music/music-tools.js";
import { WEB_TOOL_SETTINGS } from "../tools/web/web-tools.js";
import { CALENDAR_TOOL_SETTINGS } from "./product-tools/calendar-provider.js";
import { homeProductToolProvider } from "./product-tools/home-provider.js";

/** Authoritative prompt-independent metadata for first-class foundation tools.
 * Runtime runners and settings/default projections consume these same product
 * definitions rather than reconstructing names from retired transports. */
export interface FoundationProductToolMetadata extends ProductToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly tier: ImpactTier;
}

export function foundationProductToolMetadata(): readonly FoundationProductToolMetadata[] {
  return [
    ...WEB_TOOL_SETTINGS.map((tool) => ({
      ...tool,
      productGroup: "web" as const,
      defaultExposure: "standard" as const,
    })),
    ...homeProductToolProvider.create({}).map((runner) => ({
      name: runner.definition.name,
      description: runner.definition.description,
      tier: runner.definition.tier,
      productGroup: "home" as const,
      defaultExposure: runner.definition.defaultExposure ?? "standard",
    })),
    ...MUSIC_TOOL_SETTINGS.map((tool) => ({
      ...tool,
      productGroup: "music" as const,
      defaultExposure: "standard" as const,
    })),
    ...CALENDAR_TOOL_SETTINGS.map((tool) => ({
      ...tool,
      productGroup: "calendar" as const,
      defaultExposure: "standard" as const,
    })),
  ];
}
