import { z } from "zod";

export const platforms = ["web", "ios"] as const;
export const statuses = ["planned", "in-progress", "reviewed", "excluded", "unreachable"] as const;
export const surfaceTypes = ["gate", "route", "pane", "drawer", "dialog", "sheet", "menu", "control", "banner", "overlay", "state"] as const;

const nonEmpty = z.string().trim().min(1);
const sourcePath = nonEmpty.refine((value) => !value.startsWith("/") && !value.includes(".."), "must be a repository-relative path");
const authority = nonEmpty.refine(
  (value) =>
    value.startsWith("DESIGN.MD#") ||
    /^design\/prototype\/[^/]+\/(README|handoff)\.md(?:#.+)?$/.test(value) ||
    value.startsWith("native:iOS:"),
  "authority must be DESIGN.MD, a reviewed prototype README/handoff, or an explicit iOS native adaptation",
);

export const inventoryRowSchema = z.object({
  id: z.string().regex(/^(web|ios)\.[a-z0-9][a-z0-9.-]*$/),
  platform: z.enum(platforms),
  reachability: z.object({ root: sourcePath, path: nonEmpty }),
  surfaceType: z.enum(surfaceTypes),
  state: nonEmpty,
  designAuthority: z.array(authority).min(1),
  implementationPath: sourcePath,
  taskOwner: z.string().regex(/^refresh-[a-z0-9-]+$/),
  functionalProof: z.array(z.string().regex(/^(E2E-00[1-9]|TEST:[^\s]+|REVIEW:[^\s]+)$/)).min(1),
  requiredConfigurations: z.array(nonEmpty).min(1),
  visualEvidenceIds: z.array(z.string().regex(/^VE-(WEB|IOS)-[A-Z0-9-]+$/)).min(1),
  intentionalNativeAdaptation: z.string(),
  status: z.enum(statuses),
  exclusionReason: z.string(),
  reachabilityEvidence: z.array(sourcePath).min(1),
  assetCopies: z
    .array(
      z.object({
        canonicalPath: sourcePath,
        productionPath: sourcePath,
        canonicalSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .default([]),
}).superRefine((row, ctx) => {
  if (row.platform !== row.id.split(".")[0]) ctx.addIssue({ code: "custom", message: "id platform prefix must match platform" });
  if ((row.status === "excluded" || row.status === "unreachable") !== (row.exclusionReason.length > 0)) {
    ctx.addIssue({ code: "custom", message: "excluded/unreachable rows require a reason; reachable rows must not have one" });
  }
  if (row.platform === "ios" && row.intentionalNativeAdaptation.length === 0) {
    ctx.addIssue({ code: "custom", message: "iOS rows must record an adaptation or explicitly say none" });
  }
});

export const inventorySchema = z.object({
  version: z.literal(1),
  roots: z.array(sourcePath).min(1),
  configurations: z.record(z.string(), z.object({ platform: z.enum(platforms), description: nonEmpty })),
  owners: z.record(z.string().regex(/^refresh-[a-z0-9-]+$/), nonEmpty),
  rows: z.array(inventoryRowSchema).min(1),
});

const measure = z.discriminatedUnion("applicable", [
  z.object({ applicable: z.literal(true), value: z.number().nonnegative(), unit: z.enum(["css-px", "pt"]), result: z.enum(["pass", "needs-review"]) }),
  z.object({ applicable: z.literal(false), reason: nonEmpty }),
]);

export const visualReviewEntrySchema = z.object({
  evidenceId: z.string().regex(/^VE-(WEB|IOS)-[A-Z0-9-]+$/),
  inventoryId: z.string().regex(/^(web|ios)\./),
  status: z.enum(["pending", "reviewed"]),
  configurations: z.array(nonEmpty).min(1),
  evidencePaths: z.array(sourcePath),
  measurements: z.object({ overflow: measure, minimumTarget: measure, focus: measure }),
  nativeAdaptation: z.string(),
  reviewerNotes: z.string(),
}).superRefine((entry, ctx) => {
  if (entry.status === "reviewed" && entry.evidencePaths.length === 0) ctx.addIssue({ code: "custom", message: "reviewed evidence requires at least one file" });
});

export const visualManifestSchema = z.object({ version: z.literal(1), entries: z.array(visualReviewEntrySchema) });

/** Sanitized sidecar emitted by a real render/simulator capture run. */
export const visualEvidenceDocumentSchema = z.object({
  version: z.literal(1),
  kind: z.literal("design-refresh-visual-evidence"),
  platform: z.enum(platforms),
  inventoryIds: z.array(z.string().regex(/^(web|ios)\./)).min(1),
  captures: z.array(z.object({ configuration: nonEmpty, path: sourcePath })).min(1),
  observations: z.array(z.object({
    inventoryId: z.string().regex(/^(web|ios)\./),
    configuration: nonEmpty,
    overflow: z.number().nonnegative(),
    minimumTarget: z.number().nonnegative().nullable(),
    focusableCount: z.number().int().nonnegative(),
  })).min(1),
});

const e2eText = z.array(nonEmpty).min(1);
export const e2eCaseSchema = z.object({
  id: z.string().regex(/^E2E-00[1-9]$/),
  platform: z.enum(platforms),
  title: nonEmpty,
  classification: z.enum(["golden-path", "edge"]),
  inventoryIds: z.array(z.string().regex(/^(web|ios)\./)).min(1),
  setup: e2eText,
  actions: e2eText,
  expectedOutcomes: e2eText,
  evidence: e2eText,
  safety: e2eText,
  entrypoint: sourcePath,
});
export const e2eMatrixSchema = z.object({ version: z.literal(1), cases: z.array(e2eCaseSchema) });

export type Inventory = z.infer<typeof inventorySchema>;
export type VisualManifest = z.infer<typeof visualManifestSchema>;
