import type { PushConfig } from "@sentient/config";
import type { PushDeliveryPayload } from "@sentient/protocol";
import type {
  ApnsPushProvider,
  AuthorizedPushContentResolver,
  PushBindingDestination,
  PushBindingDirectory,
  PushDeliveryRequest,
  PushDeliveryService,
  PushFailure,
  PushResult,
} from "./contracts.js";
import type { PushReceiptStore, PushTokenInvalidator } from "./push-store.js";

export interface PushDeliveryDeps {
  bindings: PushBindingDirectory;
  content: AuthorizedPushContentResolver;
  provider: ApnsPushProvider;
  receipts: PushReceiptStore;
  invalidator?: PushTokenInvalidator;
  config: Pick<PushConfig, "request_timeout_ms" | "payload_max_bytes" | "content_preview_max_chars">;
  now?: () => Date;
}

/** One queue attempt. It never schedules, retries, resolves chat, or mutates an occurrence. */
export function createPushDeliveryService(deps: PushDeliveryDeps): PushDeliveryService {
  return {
    async deliver(request: PushDeliveryRequest, signal: AbortSignal) {
      if (signal.aborted) return closed();
      const initial = await deps.bindings.activeForUser(request.content.ownerUserId);
      if (!initial.ok) return initial;
      const accepted = [];
      let retryableFailure: PushFailure | undefined;

      for (const candidate of initial.value) {
        if (signal.aborted) return closed();
        const prior = await deps.receipts.read(request.deliveryId, candidate.bindingId, candidate.generation);
        if (prior) {
          accepted.push(prior);
          continue;
        }

        // Both checks deliberately occur for every destination and every queue attempt.
        // No private text or token cached by an earlier attempt is trusted.
        const current = await currentDestination(deps.bindings, candidate);
        if (!current.ok) {
          if (current.error.retryable) retryableFailure ??= current.error;
          continue;
        }
        if (!current.value) continue;
        const resolved = await deps.content.resolve(request.content, signal);
        if (!resolved.ok) {
          if (resolved.error.retryable) retryableFailure ??= resolved.error;
          continue;
        }
        // Resolution can take time; re-check binding generation, token,
        // enablement, and privacy once more at the actual send boundary.
        const sendDestination = await currentDestination(deps.bindings, candidate);
        if (!sendDestination.ok) {
          if (sendDestination.error.retryable) retryableFailure ??= sendDestination.error;
          continue;
        }
        if (!sendDestination.value) continue;
        const payload = buildPushPayload(
          sendDestination.value,
          request.content.sessionId,
          resolved.value.plainText,
          deps.config,
        );
        if (!payload.ok) continue;
        const timeout = AbortSignal.timeout(deps.config.request_timeout_ms);
        const combined = AbortSignal.any([signal, timeout]);
        const delivered = await deps.provider.deliver(sendDestination.value, payload.value, combined);
        if (delivered.ok) {
          await deps.receipts.record(
            request.deliveryId,
            sendDestination.value.bindingId,
            sendDestination.value.generation,
            delivered.value,
          );
          accepted.push(delivered.value);
        } else if (delivered.error.code === "binding_generation_mismatch" || delivered.error.code === "not_found") {
          await deps.invalidator?.disableDestination(
            sendDestination.value.bindingId,
            sendDestination.value.generation,
            deps.now?.() ?? new Date(),
          );
        } else if (delivered.error.retryable) retryableFailure ??= delivered.error;
      }
      return retryableFailure ? { ok: false, error: retryableFailure } : { ok: true, value: accepted };
    },
  };
}

async function currentDestination(
  directory: PushBindingDirectory,
  candidate: PushBindingDestination,
): Promise<PushResult<PushBindingDestination | null>> {
  const current = await directory.activeForUser(candidate.ownerUserId);
  if (!current.ok) return current;
  return {
    ok: true,
    value:
      current.value.find(
        (item) => item.bindingId === candidate.bindingId && item.generation === candidate.generation,
      ) ?? null,
  };
}

export function buildPushPayload(
  destination: PushBindingDestination,
  sessionId: string,
  plainText: string,
  config: Pick<PushConfig, "payload_max_bytes" | "content_preview_max_chars">,
): PushResult<PushDeliveryPayload> {
  const base = {
    bindingId: destination.bindingId,
    generation: destination.generation,
    sessionId,
    title: "New message" as const,
  };
  if (destination.previewMode === "hidden") {
    const payload = { ...base, mode: "hidden" as const };
    return fits(payload, config.payload_max_bytes)
      ? { ok: true, value: payload }
      : { ok: false, error: { code: "validation", retryable: false } };
  }
  const normalized = plainText.replace(/\s+/gu, " ").trim();
  if (!normalized) return { ok: false, error: { code: "validation", retryable: false } };
  const chars = Array.from(normalized).slice(0, config.content_preview_max_chars).join("");
  const body = truncateForBytes(
    chars,
    (candidate) => providerWireBytes({ ...base, mode: "content" as const, body: candidate }),
    config.payload_max_bytes,
  );
  if (!body) return { ok: false, error: { code: "validation", retryable: false } };
  return { ok: true, value: { ...base, mode: "content", body } };
}

/** Measures the APNs JSON represented by the Gorush adapter, metadata included. */
function providerWireBytes(payload: PushDeliveryPayload): number {
  return new TextEncoder().encode(
    JSON.stringify({
      aps: { alert: { title: payload.title, ...(payload.body ? { body: payload.body } : {}) } },
      bindingId: payload.bindingId,
      generation: payload.generation,
      sessionId: payload.sessionId,
      mode: payload.mode,
    }),
  ).byteLength;
}
function fits(payload: PushDeliveryPayload, max: number): boolean {
  return providerWireBytes(payload) <= max;
}
function truncateForBytes(value: string, size: (candidate: string) => number, max: number): string {
  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(chars.slice(0, mid).join("")) <= max) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("");
}
function closed<T>(): PushResult<T> {
  return { ok: false, error: { code: "closed", retryable: false } };
}
