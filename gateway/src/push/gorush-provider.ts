import { createHash } from "node:crypto";
import type { PushDeliveryPayload } from "@sentient/protocol";
import { z } from "zod";
import type { ApnsPushProvider, PushBindingDestination, PushResult } from "./contracts.js";

const responseSchema = z
  .object({
    counts: z.number().int().nonnegative().optional(),
    logs: z.array(z.object({ type: z.string().optional(), error: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

export interface GorushProviderOptions {
  url: string;
  topic: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
}

/** Replaceable APNs transport only. Retry and delivery state remain above this adapter. */
export function createGorushApnsProvider(options: GorushProviderOptions): ApnsPushProvider {
  const request = options.fetch ?? fetch;
  return {
    async deliver(
      destination: Pick<PushBindingDestination, "apnsDeviceToken">,
      payload: PushDeliveryPayload,
      signal: AbortSignal,
    ) {
      try {
        const response = await request(options.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            notifications: [
              {
                tokens: [destination.apnsDeviceToken],
                platform: 1,
                topic: options.topic,
                title: payload.title,
                message: payload.body ?? "",
                data: {
                  bindingId: payload.bindingId,
                  generation: payload.generation,
                  sessionId: payload.sessionId,
                  mode: payload.mode,
                },
                collapse_key: stableNotificationId(payload),
              },
            ],
          }),
          signal,
        });
        if (!response.ok) return providerFailure(response.status >= 500 || response.status === 429);
        const parsed = responseSchema.safeParse(await response.json());
        if (!parsed.success) return providerFailure(true);
        const failed = parsed.data.logs?.some((entry) => entry.type?.toLowerCase() === "failed" || entry.error);
        if (failed || parsed.data.counts === 0) {
          const permanent = parsed.data.logs?.some((entry) =>
            /baddevicetoken|unregistered|device token not for topic/i.test(entry.error ?? ""),
          );
          return permanent ? { ok: false, error: { code: "not_found", retryable: false } } : providerFailure(true);
        }
        return {
          ok: true,
          value: {
            providerMessageId: stableNotificationId(payload),
            acceptedAt: (options.now?.() ?? new Date()).toISOString(),
          },
        };
      } catch {
        return signal.aborted ? { ok: false, error: { code: "closed", retryable: false } } : providerFailure(true);
      }
    },
  };
}
function stableNotificationId(payload: PushDeliveryPayload): string {
  return createHash("sha256")
    .update(`${payload.bindingId}:${payload.generation}:${payload.sessionId}`)
    .digest("hex")
    .slice(0, 32);
}
function providerFailure(retryable: boolean): PushResult<never> {
  return { ok: false, error: { code: "provider_unavailable", retryable } };
}
