import { z } from "zod";
import goldenPushFixtures from "./fixtures/push-wire.json";

/** iOS/APNs-only public surface. Browser settings may explain unavailability but cannot register delivery. */
export const PUSH_REGISTRATIONS_ROUTE = "/api/v1/push/registrations" as const;
export const PUSH_PREFERENCES_ROUTE = "/api/v1/push/preferences" as const;
export const PUSH_REVOCATIONS_ROUTE = "/api/v1/push/revocations" as const;

const instantSchema = z.string().datetime({ offset: true });
export const pushPreviewModeSchema = z.enum(["hidden", "content"]);
export const pushPreferencesSchema = z
  .object({ enabled: z.boolean(), previewMode: pushPreviewModeSchema, revision: z.number().int().positive() })
  .strict();

export const pushBindingSchema = z
  .object({
    bindingId: z.string().min(1),
    installationId: z.string().min(1).max(200),
    platform: z.literal("ios"),
    generation: z.number().int().positive(),
    state: z.enum(["active", "disabled", "pending-old-binding-disable"]),
    preferences: pushPreferencesSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();

/**
 * Narrow bearer authority returned at registration. The credential authorizes only
 * idempotently disabling this exact `(bindingId, generation)` via the revocation route.
 * It grants no reads, account access, preference changes, or delivery activation.
 */
export const pushRevocationAuthoritySchema = z
  .object({
    bindingId: z.string().min(1),
    generation: z.number().int().positive(),
    credential: z.string().min(1),
    expiresAt: instantSchema,
  })
  .strict();

/** Authenticated POST `/api/v1/push/registrations`; installationId correlates retries and is never authority. */
export const pushRegistrationRequestSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    installationId: z.string().min(1).max(200),
    platform: z.literal("ios"),
    apnsDeviceToken: z.string().regex(/^[A-Fa-f0-9]{64,200}$/),
    replaces: z
      .object({ bindingId: z.string().min(1), generation: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();
export const pushRegistrationResponseSchema = z
  .object({ binding: pushBindingSchema, revocation: pushRevocationAuthoritySchema, replayed: z.boolean() })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.revocation.bindingId !== value.binding.bindingId ||
      value.revocation.generation !== value.binding.generation
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revocation"],
        message: "revocation authority must name the exact issued binding generation",
      });
  });

/** Authenticated GET query; installationId correlates the caller's own binding but does not authorize the read. */
export const pushPreferenceGetQuerySchema = z.object({ installationId: z.string().min(1).max(200) }).strict();
export const pushPreferenceGetResponseSchema = z.object({ binding: pushBindingSchema }).strict();

/** Authenticated PATCH; preferences are installation-local and hidden is the issuance default. */
export const pushPreferencePatchRequestSchema = z
  .object({
    bindingId: z.string().min(1),
    generation: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    changes: z
      .object({ enabled: z.boolean().optional(), previewMode: pushPreviewModeSchema.optional() })
      .strict()
      .refine((value) => Object.keys(value).length > 0, "at least one change is required"),
  })
  .strict();
export const pushPreferencePatchResponseSchema = z.object({ binding: pushBindingSchema }).strict();

/**
 * Unauthenticated narrow POST `/api/v1/push/revocations`. Logout may finish locally
 * before this acknowledgement; clients retain only this request and retry it verbatim.
 */
export const pushRevokeRequestSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    bindingId: z.string().min(1),
    generation: z.number().int().positive(),
    revocationCredential: z.string().min(1),
  })
  .strict();
export const pushRevokeAcknowledgementSchema = z
  .object({
    bindingId: z.string().min(1),
    generation: z.number().int().positive(),
    status: z.enum(["revoked", "already-revoked"]),
    acknowledgedAt: instantSchema,
  })
  .strict();

/**
 * Client-persisted logout cleanup state. `pending-unlink` is intentionally not
 * "revoked": local logout has completed but delivery (including previews) may
 * continue until the exact request receives a server acknowledgement.
 */
export const pushUnlinkStateSchema = z.union([
  z
    .object({ state: z.literal("linked"), binding: pushBindingSchema, revocation: pushRevocationAuthoritySchema })
    .strict(),
  z
    .object({
      state: z.literal("pending-unlink"),
      request: pushRevokeRequestSchema,
      deliveryMayContinue: z.literal(true),
    })
    .strict(),
  z.object({ state: z.literal("unlinked"), acknowledgement: pushRevokeAcknowledgementSchema }).strict(),
]);

/** Invalid/expired authority is an error, never a synthetic revoked acknowledgement. */
export const pushErrorCodeSchema = z.enum([
  "validation",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "invalid_revocation_authority",
  "expired_revocation_authority",
  "binding_generation_mismatch",
  "old_binding_active",
  "provider_unavailable",
  "internal",
]);
export const pushErrorSchema = z
  .object({
    error: z
      .object({ code: pushErrorCodeSchema, message: z.string().min(1).max(500), retryable: z.boolean() })
      .strict(),
  })
  .strict();

/** Provider payload after privacy has been applied. Hidden mode cannot carry content. */
export const pushDeliveryPayloadSchema = z
  .object({
    bindingId: z.string().min(1),
    generation: z.number().int().positive(),
    sessionId: z.string().min(1),
    title: z.literal("New message"),
    mode: pushPreviewModeSchema,
    body: z.string().min(1).max(280).optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.mode === "hidden" && payload.body !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "hidden payloads cannot contain content" });
    if (payload.mode === "content" && payload.body === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "content payloads require a bounded body" });
  });

export type PushBinding = z.infer<typeof pushBindingSchema>;
export type PushRegistrationRequest = z.infer<typeof pushRegistrationRequestSchema>;
export type PushRevocationAuthority = z.infer<typeof pushRevocationAuthoritySchema>;
export type PushRevokeRequest = z.infer<typeof pushRevokeRequestSchema>;
export type PushUnlinkState = z.infer<typeof pushUnlinkStateSchema>;
export type PushDeliveryPayload = z.infer<typeof pushDeliveryPayloadSchema>;
export type PushErrorCode = z.infer<typeof pushErrorCodeSchema>;
export const goldenPushWireFixtures = goldenPushFixtures;
