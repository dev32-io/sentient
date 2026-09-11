import { describe, expect, it } from "vitest";
import {
  goldenPushWireFixtures as fixture,
  pushBindingSchema,
  pushDeliveryPayloadSchema,
  pushErrorSchema,
  pushPreferencePatchRequestSchema,
  pushRegistrationRequestSchema,
  pushRegistrationResponseSchema,
  pushRevokeAcknowledgementSchema,
  pushRevokeRequestSchema,
  pushUnlinkStateSchema,
} from "./push";

describe("push wire authority and privacy boundary", () => {
  it("issues an exact hidden-by-default iOS binding and rejects provider variants", () => {
    expect(pushRegistrationRequestSchema.safeParse(fixture.registration).success).toBe(true);
    expect(pushRegistrationResponseSchema.safeParse(fixture.issued).success).toBe(true);
    expect(fixture.issued.binding.preferences.previewMode).toBe("hidden");
    expect(pushRegistrationRequestSchema.safeParse({ ...fixture.registration, platform: "android" }).success).toBe(
      false,
    );
    expect(pushRegistrationRequestSchema.safeParse({ ...fixture.registration, provider: "fcm" }).success).toBe(false);
    expect(
      pushRegistrationResponseSchema.safeParse({
        ...fixture.issued,
        revocation: { ...fixture.issued.revocation, generation: 6 },
      }).success,
    ).toBe(false);
  });

  it("confines revoke-only requests and never represents invalid authority as an acknowledgement", () => {
    expect(pushUnlinkStateSchema.safeParse(fixture.pendingUnlink).success).toBe(true);
    expect(pushRevokeRequestSchema.safeParse(fixture.pendingUnlink.request).success).toBe(true);
    expect(pushRevokeRequestSchema.safeParse({ ...fixture.pendingUnlink.request, readPreferences: true }).success).toBe(
      false,
    );
    expect(pushRevokeAcknowledgementSchema.safeParse(fixture.revokeAcknowledgement).success).toBe(true);
    expect(pushRevokeAcknowledgementSchema.safeParse(fixture.expiredAuthority).success).toBe(false);
    expect(pushErrorSchema.safeParse(fixture.expiredAuthority).success).toBe(true);
    expect(pushErrorSchema.safeParse(fixture.retryableFailure).success).toBe(true);
  });

  it("prevents content in hidden payloads and requires bounded content in content mode", () => {
    expect(pushDeliveryPayloadSchema.safeParse(fixture.hiddenPayload).success).toBe(true);
    expect(pushDeliveryPayloadSchema.safeParse(fixture.contentPayload).success).toBe(true);
    expect(pushDeliveryPayloadSchema.safeParse({ ...fixture.hiddenPayload, body: "secret message" }).success).toBe(
      false,
    );
    expect(pushDeliveryPayloadSchema.safeParse({ ...fixture.contentPayload, body: undefined }).success).toBe(false);
    expect(pushDeliveryPayloadSchema.safeParse({ ...fixture.contentPayload, body: "x".repeat(281) }).success).toBe(
      false,
    );
  });

  it("fences replacement activation and uses generation/revision CAS for per-device preferences", () => {
    expect(pushBindingSchema.safeParse(fixture.replacementPending).success).toBe(true);
    expect(fixture.replacementPending.state).toBe("pending-old-binding-disable");
    expect(
      pushPreferencePatchRequestSchema.safeParse({
        bindingId: "bind_1",
        generation: 7,
        expectedRevision: 1,
        changes: { previewMode: "content" },
      }).success,
    ).toBe(true);
    expect(
      pushPreferencePatchRequestSchema.safeParse({
        bindingId: "bind_1",
        generation: 7,
        expectedRevision: 1,
        changes: {},
      }).success,
    ).toBe(false);
  });
});
