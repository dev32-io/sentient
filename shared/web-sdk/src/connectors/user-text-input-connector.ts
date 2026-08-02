import type { Connector, SentientSDKInternal } from "../connector-types.ts";

// ---------------------------------------------------------------------------
// UserTextInputConnector — sends text input to the gateway.
//
// Capability: "text.input"
// Direction: input
//
// Sends: text.input
// ---------------------------------------------------------------------------

export class UserTextInputConnector implements Connector {
  readonly capability = "text.input";
  readonly kind = "input" as const;

  private sdk: SentientSDKInternal | null = null;

  attach(sdk: SentientSDKInternal): void {
    this.sdk = sdk;
  }

  detach(): void {
    this.sdk = null;
  }

  /**
   * Send a text message to the gateway.
   *
   * `pendingId` is the message's idempotency key, and the gateway's dedup is
   * durable (`store.findByPendingId`), so a message that reaches it twice is
   * committed once and answered once. Web has no outbox and does not resend
   * today, which is exactly why this is worth sending NOW rather than when one
   * lands: the gateway-side guarantee is stated as "one entry per message" and
   * a client that omits the key silently opts out of it. Mobile has always sent
   * one; this closes the gap so the claim holds for every shipped client.
   */
  sendText(text: string): void {
    if (this.sdk === null) return;
    this.sdk.send({ type: "text.input", text, pendingId: globalThis.crypto.randomUUID() });
  }
}
