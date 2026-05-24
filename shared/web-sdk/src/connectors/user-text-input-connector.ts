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

  /** Send a text message to the gateway. */
  sendText(text: string): void {
    if (this.sdk === null) return;
    this.sdk.send({ type: "text.input", text });
  }
}
