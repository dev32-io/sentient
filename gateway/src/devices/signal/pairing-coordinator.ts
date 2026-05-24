import QRCode from "qrcode";
import { getLog } from "../../logging/logger.js";
import type { SignalCliClient } from "./signal-cli-client.js";

const log = getLog(["sentient", "devices", "signal", "coordinator"]);

export type PairingState = "idle" | "provisioning" | "linking" | "awaitingScan" | "finalizing" | "linked" | "failed";

const LINK_TTL_MS = 5 * 60 * 1000;

export interface PairingDeps {
  provisionSignalCli: () => Promise<void>;
  waitForHealth: () => Promise<void>;
  finalizePair: (account: string) => Promise<void>;
  cleanupOnFail: () => Promise<void>;
  client: SignalCliClient;
  now: () => number;
  /** Injected for testability — defaults to global setTimeout. */
  scheduleTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injected for testability — defaults to global clearTimeout. */
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
  /** Injected for testability — defaults to qrcode.toDataURL. */
  renderQr?: (uri: string) => Promise<string>;
}

export class PairingCoordinator {
  private _state: PairingState = "idle";
  private _qrDataUrl: string | undefined;
  private _error: string | undefined;
  private _expiresAt: number | undefined;
  private _expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private _abortController: AbortController | undefined;

  private readonly _setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly _clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  private readonly _renderQr: (uri: string) => Promise<string>;

  constructor(
    private readonly userId: string,
    private readonly deps: PairingDeps,
  ) {
    this._setTimeout = deps.scheduleTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this._clearTimeout = deps.clearTimeoutFn ?? ((id) => clearTimeout(id));
    this._renderQr = deps.renderQr ?? defaultRenderQr;
  }

  get state(): PairingState {
    return this._state;
  }

  get error(): string | undefined {
    return this._error;
  }

  /** data:image/png;base64,... rendered from the signal-cli deviceLinkUri.
   *  Returns undefined unless state=awaitingScan. */
  getQrDataUrl(): string | undefined {
    return this._state === "awaitingScan" ? this._qrDataUrl : undefined;
  }

  get expiresAt(): number | undefined {
    return this._expiresAt;
  }

  async startPair(): Promise<void> {
    if (this._state !== "idle" && this._state !== "failed") {
      throw new Error(`pairing in progress (state=${this._state})`);
    }
    this._error = undefined;
    log.info("pair-start", { userId: this.userId });

    this._state = "provisioning";
    try {
      await this.deps.provisionSignalCli();
      await this.deps.waitForHealth();
    } catch (err) {
      await this.failWith(`provisioning failed: ${String(err)}`);
      return;
    }

    this._state = "linking";
    let deviceLinkUri: string;
    try {
      const start = await this.deps.client.startLink({
        deviceName: `Sentient-${this.userId}`,
      });
      deviceLinkUri = start.deviceLinkUri;
      this._qrDataUrl = await this._renderQr(deviceLinkUri);
      this._expiresAt = this.deps.now() + LINK_TTL_MS;
    } catch (err) {
      await this.failWith(`startLink failed: ${String(err)}`);
      return;
    }

    this._state = "awaitingScan";
    this.beginFinishLink(deviceLinkUri);
  }

  async cancel(): Promise<void> {
    if (this._state === "idle" || this._state === "linked") return;
    this.stopTimers();
    this._abortController?.abort();
    await this.deps.cleanupOnFail();
    this._state = "idle";
    this._qrDataUrl = undefined;
    this._expiresAt = undefined;
  }

  /** Issue the daemon-side finishLink call. The daemon blocks the HTTP
   *  response until the phone scans + confirms (or its internal timeout
   *  fires). On success the account is bound and added to the daemon's
   *  multi-account store; we then run finalize to write SIGNAL_* env and
   *  restart the per-user hermes-gateway program. */
  private beginFinishLink(deviceLinkUri: string): void {
    this._abortController = new AbortController();
    const { signal } = this._abortController;

    this._expiryTimer = this._setTimeout(() => {
      void this.failWith("link uri expired");
    }, LINK_TTL_MS);

    void (async () => {
      try {
        const result = await this.deps.client.finishLink({
          deviceLinkUri,
          deviceName: `Sentient-${this.userId}`,
          signal,
        });
        if (signal.aborted) return;
        if (this._state !== "awaitingScan") return;
        this.stopTimers();
        this._state = "finalizing";
        await this.deps.finalizePair(result.number);
        this._state = "linked";
        log.info("pair-linked", { userId: this.userId });
      } catch (err) {
        if (signal.aborted) return;
        await this.failWith(`finishLink failed: ${String(err)}`);
      }
    })();
  }

  private async failWith(reason: string): Promise<void> {
    log.warn("pair-failed", { userId: this.userId, reason });
    this.stopTimers();
    this._abortController?.abort();
    this._state = "failed";
    this._error = reason;
    try {
      await this.deps.cleanupOnFail();
    } catch {
      // swallow cleanup errors — failure is already recorded
    }
  }

  private stopTimers(): void {
    if (this._expiryTimer !== undefined) {
      this._clearTimeout(this._expiryTimer);
      this._expiryTimer = undefined;
    }
  }
}

async function defaultRenderQr(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: "M", width: 480, margin: 1 });
}
