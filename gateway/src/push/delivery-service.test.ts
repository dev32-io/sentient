import { describe, expect, it } from "bun:test";
import type { UserId } from "../user-auth/user-id.js";
import type { PushBindingDestination, PushDeliveryReceipt } from "./contracts.js";
import { buildPushPayload, createPushDeliveryService } from "./delivery-service.js";
import { createGorushApnsProvider } from "./gorush-provider.js";

const ownerUserId = "u_a11ce001" as UserId;
const destination = (id: string, mode: "hidden" | "content" = "hidden"): PushBindingDestination => ({
  bindingId: id,
  generation: 1,
  ownerUserId,
  installationId: id,
  apnsDeviceToken: "0".repeat(64),
  enabled: true,
  previewMode: mode,
});
const config = { request_timeout_ms: 1000, payload_max_bytes: 512, content_preview_max_chars: 280 };

describe("private push delivery", () => {
  it("re-reads privacy/access per destination, persists partial acceptance, and retry does not resend it", async () => {
    let active = [destination("one", "content"), destination("two", "hidden")];
    const sent: unknown[] = [];
    const receipt = new Map<string, PushDeliveryReceipt>();
    let resolveCount = 0;
    const service = createPushDeliveryService({
      config,
      bindings: { activeForUser: async () => ({ ok: true, value: active }) },
      content: { resolve: async () => ({ ok: true, value: { plainText: `private ${++resolveCount}` } }) },
      provider: {
        deliver: async (dest, payload) => {
          sent.push(payload);
          return dest.apnsDeviceToken === active[0]?.apnsDeviceToken && sent.length === 1
            ? { ok: true, value: { acceptedAt: "2026-01-01T00:00:00Z" } }
            : { ok: false, error: { code: "provider_unavailable", retryable: true } };
        },
      },
      receipts: {
        read: async (delivery, binding) => receipt.get(`${delivery}:${binding}`) ?? null,
        record: async (delivery, binding, _generation, value) => {
          receipt.set(`${delivery}:${binding}`, value);
        },
      },
    });
    const job = {
      deliveryId: "delivery",
      content: { ownerUserId, sessionId: "session", entryId: "entry" },
      attempt: 1,
    };
    expect((await service.deliver(job, new AbortController().signal)).ok).toBe(false);
    active = [destination("one", "hidden"), destination("two", "content")];
    await service.deliver({ ...job, attempt: 2 }, new AbortController().signal);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ bindingId: "one", mode: "content", body: "private 1" });
    expect(sent[1]).toMatchObject({ bindingId: "two", mode: "hidden" });
    expect(sent[2]).toMatchObject({ bindingId: "two", mode: "content", body: "private 3" });
  });

  it("does not persist a receipt for malformed Gorush acceptance", async () => {
    const receipts: PushDeliveryReceipt[] = [];
    const service = createPushDeliveryService({
      config,
      bindings: { activeForUser: async () => ({ ok: true, value: [destination("one")] }) },
      content: { resolve: async () => ({ ok: true, value: { plainText: "synthetic" } }) },
      provider: createGorushApnsProvider({
        url: "http://127.0.0.1:8088/api/push",
        topic: "io.dev32.sentient.debug",
        sandbox: true,
        fetch: async () => Response.json({ success: "ok", counts: 1, logs: [] }),
      }),
      receipts: {
        read: async () => null,
        record: async (_delivery, _binding, _generation, receipt) => {
          receipts.push(receipt);
        },
      },
    });
    expect(
      await service.deliver(
        {
          deliveryId: "delivery",
          content: { ownerUserId, sessionId: "session", entryId: "entry" },
          attempt: 1,
        },
        new AbortController().signal,
      ),
    ).toEqual({
      ok: false,
      error: { code: "provider_unavailable", retryable: true },
    });
    expect(receipts).toHaveLength(0);
  });

  it("bounds actual UTF-8 wire bytes including routing metadata", () => {
    const result = buildPushPayload(destination("binding", "content"), "session", "😀".repeat(280), {
      payload_max_bytes: 512,
      content_preview_max_chars: 280,
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(
        new TextEncoder().encode(
          JSON.stringify({
            aps: { alert: { title: result.value.title, body: result.value.body } },
            bindingId: result.value.bindingId,
            generation: 1,
            sessionId: "session",
            mode: "content",
          }),
        ).byteLength,
      ).toBeLessThanOrEqual(512);
  });
});
