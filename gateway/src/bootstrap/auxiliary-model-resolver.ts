import type { Result } from "@sentient/protocol";
import type { ProfileStore } from "../profile-store/profile-store.js";
import type { ModelProvider, ModelRef, ProfileV1 } from "../profile-store/profile-types.js";
import type { ModelEntry } from "../providers/catalogs/types.js";

export type AuxiliaryModelPurpose = "title" | "dreamer" | "attachmentVision";
export type AuxiliaryModelSource = "user-override" | "user-chat" | "operator-default";
export type AuxiliaryModelError =
  | "provider-mismatch"
  | "no-default"
  | "catalog-unavailable"
  | "model-not-found"
  | "vision-unsupported";

export interface ResolvedAuxiliaryModel {
  readonly ref: ModelRef;
  readonly source: AuxiliaryModelSource;
}

export interface AuxiliaryModelResolverDeps {
  readonly activeProvider: ModelProvider;
  readonly chatModel: string;
  readonly dreamerModel: string;
  readonly attachmentVisionModel: string;
  readonly profileStore: ProfileStore;
  readonly listModels?: () => Promise<{ ok: true; value: readonly ModelEntry[] } | { ok: false; error: unknown }>;
}

export interface AuxiliaryResolveOptions {
  readonly activeProvider: ModelProvider;
  readonly resolveVisionModel: (
    provider: ModelProvider,
    id: string,
  ) => Promise<{ readonly supportsVision: boolean; readonly visionCapabilityKnown: boolean } | null>;
}

export interface AuxiliaryModelResolver {
  resolve(
    userId: string,
    purpose: AuxiliaryModelPurpose,
    options?: AuxiliaryResolveOptions,
  ): Promise<Result<ResolvedAuxiliaryModel, AuxiliaryModelError>>;
}

export function createAuxiliaryModelResolver(deps: AuxiliaryModelResolverDeps): AuxiliaryModelResolver {
  return {
    async resolve(userId, purpose, options) {
      const stored = await deps.profileStore.get(userId);
      const profile = stored.ok ? stored.value : undefined;
      const activeProvider = options?.activeProvider ?? deps.activeProvider;
      const selected = select(profile, purpose, { ...deps, activeProvider });
      if (!selected.ok) return selected;
      if (selected.value.ref.provider !== activeProvider) {
        return { ok: false, error: "provider-mismatch" };
      }
      if (purpose !== "attachmentVision") return selected;
      if (options) {
        const model = await options.resolveVisionModel(selected.value.ref.provider, selected.value.ref.id);
        if (!model) return { ok: false, error: "model-not-found" };
        if (!model.visionCapabilityKnown || !model.supportsVision) {
          return { ok: false, error: "vision-unsupported" };
        }
        return selected;
      }
      return validateVision(selected.value, deps.listModels);
    },
  };
}

function select(
  profile: ProfileV1 | undefined,
  purpose: AuxiliaryModelPurpose,
  deps: Pick<AuxiliaryModelResolverDeps, "activeProvider" | "chatModel" | "dreamerModel" | "attachmentVisionModel">,
): Result<ResolvedAuxiliaryModel, AuxiliaryModelError> {
  const override = profile?.auxiliaryModels?.[purpose];
  if (override) return { ok: true, value: { ref: override, source: "user-override" } };

  if (purpose === "title" && profile) {
    return { ok: true, value: { ref: profile.model, source: "user-chat" } };
  }
  if (purpose === "attachmentVision") {
    if (deps.activeProvider !== "ollama-cloud") return { ok: false, error: "no-default" };
    return {
      ok: true,
      value: {
        ref: { provider: "ollama-cloud", id: deps.attachmentVisionModel },
        source: "operator-default",
      },
    };
  }

  const id = purpose === "dreamer" && deps.dreamerModel ? deps.dreamerModel : deps.chatModel;
  return {
    ok: true,
    value: { ref: { provider: deps.activeProvider, id }, source: "operator-default" },
  };
}

async function validateVision(
  selected: ResolvedAuxiliaryModel,
  listModels: AuxiliaryModelResolverDeps["listModels"],
): Promise<Result<ResolvedAuxiliaryModel, AuxiliaryModelError>> {
  if (!listModels) return { ok: false, error: "catalog-unavailable" };
  const catalog = await listModels();
  if (!catalog.ok) return { ok: false, error: "catalog-unavailable" };
  const model = catalog.value.find((entry) => entry.provider === selected.ref.provider && entry.id === selected.ref.id);
  if (!model) return { ok: false, error: "model-not-found" };
  if (!model.supportsVision) return { ok: false, error: "vision-unsupported" };
  return { ok: true, value: selected };
}
