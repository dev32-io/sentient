import type {
  PushBinding,
  PushDeliveryPayload,
  PushErrorCode,
  PushRegistrationRequest,
  PushRevocationAuthority as PushRevocationCredential,
  PushRevokeRequest,
} from "@sentient/protocol";
import type { Result } from "@sentient/protocol";
import type { PrivatePushResource } from "../access/private-push-resource.js";
import type { UserId } from "../user-auth/user-id.js";

export type PushFailure = Readonly<{ code: PushErrorCode | "closed"; retryable: boolean }>;
export type PushResult<T> = Result<T, PushFailure>;

export interface IssuedPushRegistration {
  readonly binding: PushBinding;
  /** Exact-generation revoke-only authority; retain this, never general account credentials, for logout cleanup. */
  readonly revocation: PushRevocationCredential;
  readonly replayed: boolean;
}

export interface PushRegistrationAuthority {
  issue(
    resource: PrivatePushResource,
    request: PushRegistrationRequest,
    now: Date,
  ): Promise<PushResult<IssuedPushRegistration>>;
  updatePreferences(
    resource: PrivatePushResource,
    bindingId: string,
    generation: number,
    expectedRevision: number,
    changes: Readonly<{ enabled?: boolean; previewMode?: "hidden" | "content" }>,
  ): Promise<PushResult<PushBinding>>;
}

/**
 * The sole unauthenticated capability operation. Invalid/expired/mismatched
 * credentials return a failure and must never be converted to `already-revoked`.
 */
export interface PushRevocationAuthority {
  revoke(
    request: PushRevokeRequest,
    now: Date,
  ): Promise<
    PushResult<
      Readonly<{
        bindingId: string;
        generation: number;
        status: "revoked" | "already-revoked";
        acknowledgedAt: string;
      }>
    >
  >;
}

/** Re-read immediately before every attempt so retries apply current enablement/privacy/token state. */
export interface PushBindingDirectory {
  activeForUser(ownerUserId: UserId): Promise<PushResult<ReadonlyArray<PushBindingDestination>>>;
}

export interface PushBindingDestination {
  readonly bindingId: string;
  readonly generation: number;
  readonly ownerUserId: UserId;
  readonly installationId: string;
  readonly apnsDeviceToken: string;
  readonly enabled: boolean;
  readonly previewMode: "hidden" | "content";
}

/** Opaque saved-content locator; queue rows contain no assistant response text. */
export interface PushContentReference {
  readonly ownerUserId: UserId;
  readonly sessionId: string;
  readonly entryId: string;
}

/** Resolves only after checking current owner/session access. */
export interface AuthorizedPushContentResolver {
  resolve(reference: PushContentReference, signal: AbortSignal): Promise<PushResult<Readonly<{ plainText: string }>>>;
}

export interface PushDeliveryReceipt {
  readonly providerMessageId?: string;
  readonly acceptedAt: string;
}

/** Current native transport contract: APNs through the configured adapter only. */
export interface ApnsPushProvider {
  deliver(
    destination: Pick<PushBindingDestination, "apnsDeviceToken">,
    payload: PushDeliveryPayload,
    signal: AbortSignal,
  ): Promise<PushResult<PushDeliveryReceipt>>;
}

export interface PushDeliveryRequest {
  readonly deliveryId: string;
  readonly content: PushContentReference;
  readonly attempt: number;
}

/** Delivery failure/retry cannot execute a chat or mutate its originating schedule. */
export interface PushDeliveryService {
  deliver(request: PushDeliveryRequest, signal: AbortSignal): Promise<PushResult<ReadonlyArray<PushDeliveryReceipt>>>;
}
