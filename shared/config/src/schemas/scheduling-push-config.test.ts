import { describe, expect, it } from "vitest";
import { pushConfigSchema } from "./push-config";
import { schedulingConfigSchema } from "./scheduling-config";

const scheduling = {
  tick_interval_ms: 1000,
  missed_grace_ms: 900000,
  claim_lease_ms: 60000,
  due_claim_limit: 25,
  max_relative_delay_ms: 31536000000,
  max_message_chars: 12000,
  cards_default_page_size: 20,
  cards_max_page_size: 100,
  inbox_max_entries: 500,
  inbox_retention_ms: 2592000000,
  outbox_claim_limit: 50,
  outbox_lease_ms: 60000,
};
const push = {
  request_timeout_ms: 5000,
  drain_interval_ms: 1000,
  drain_claim_limit: 50,
  max_attempts: 5,
  retry_base_ms: 1000,
  retry_max_ms: 60000,
  payload_max_bytes: 4096,
  content_preview_max_chars: 280,
  revocation_ttl_ms: 2592000000,
};

describe("scheduling/push operator configuration", () => {
  it("rejects unsafe cross-field timing and page limits", () => {
    expect(schedulingConfigSchema.safeParse(scheduling).success).toBe(true);
    const { inbox_max_entries: _, inbox_retention_ms: __, ...legacyScheduling } = scheduling;
    expect(schedulingConfigSchema.parse(legacyScheduling)).toMatchObject({
      inbox_max_entries: 500,
      inbox_retention_ms: 2_592_000_000,
    });
    expect(schedulingConfigSchema.safeParse({ ...scheduling, claim_lease_ms: 1000 }).success).toBe(false);
    expect(
      schedulingConfigSchema.safeParse({ ...scheduling, cards_default_page_size: 100, cards_max_page_size: 20 })
        .success,
    ).toBe(false);
    expect(schedulingConfigSchema.safeParse({ ...scheduling, missed_grace_ms: -1 }).success).toBe(false);
    expect(
      schedulingConfigSchema.safeParse({ ...scheduling, inbox_max_entries: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
    expect(schedulingConfigSchema.safeParse({ ...scheduling, inbox_retention_ms: 59_999 }).success).toBe(false);
  });

  it("keeps provider URL optional and rejects non-loopback destinations or APNs identity overrides", () => {
    expect(pushConfigSchema.parse(push)).not.toHaveProperty("provider_url");
    expect(pushConfigSchema.parse({ ...push, provider_url: "http://127.0.0.1:18088/api/push" })).toMatchObject({
      provider_url: "http://127.0.0.1:18088/api/push",
    });
    expect(pushConfigSchema.safeParse({ ...push, apns_topic: "io.example.app" }).success).toBe(false);
    expect(pushConfigSchema.safeParse({ ...push, apns_sandbox: true }).success).toBe(false);
    for (const provider_url of [
      "not-a-url",
      "http://push.example/api/push",
      "https://127.0.0.1:8088/api/push",
      "http://user:secret@127.0.0.1:8088/api/push",
      "http://127.0.0.1:8088/api/push?token=x",
      "http://127.0.0.1:8088/api/push#fragment",
      "http://127.0.0.1:8088/other",
      "http://127.0.0.1:0/api/push",
    ])
      expect(pushConfigSchema.safeParse({ ...push, provider_url }).success).toBe(false);
  });

  it("bounds APNs payload/retry policy and rejects credential-shaped extras", () => {
    expect(pushConfigSchema.safeParse(push).success).toBe(true);
    expect(pushConfigSchema.safeParse({ ...push, retry_base_ms: 60001 }).success).toBe(false);
    expect(pushConfigSchema.safeParse({ ...push, payload_max_bytes: 4097 }).success).toBe(false);
    expect(pushConfigSchema.safeParse({ ...push, apns_key: "secret" }).success).toBe(false);
  });
});
