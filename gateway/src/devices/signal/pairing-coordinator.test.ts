import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PairingCoordinator } from "./pairing-coordinator";
import type { PairingDeps } from "./pairing-coordinator";
import type { SignalCliClient } from "./signal-cli-client";

function mockClient(overrides: Partial<SignalCliClient> = {}): SignalCliClient {
  return {
    health: vi.fn(async () => true),
    startLink: vi.fn(async () => ({ deviceLinkUri: "sgnl://linkdevice?uuid=stub" })),
    finishLink: vi.fn(async () => ({ number: "+15551234567" })),
    listAccounts: vi.fn(async () => []),
    removeAccount: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SignalCliClient;
}

/** Capture the registered expiry callback so tests can fire it explicitly
 *  without driving fake timers (vi.useFakeTimers doesn't play well with the
 *  background finishLink promise). */
function makeTimerControl() {
  let expiryCallback: (() => void) | undefined;
  const scheduleTimeout = (cb: () => void) => {
    expiryCallback = cb;
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimeoutFn = () => {
    expiryCallback = undefined;
  };
  return {
    scheduleTimeout,
    clearTimeoutFn,
    fireExpiry: () => {
      expiryCallback?.();
    },
  };
}

function makeDepsWithTimers(overrides: Partial<PairingDeps> = {}): {
  deps: PairingDeps;
  fireExpiry: () => void;
} {
  const timers = makeTimerControl();
  const deps: PairingDeps = {
    provisionSignalCli: vi.fn(async () => undefined),
    waitForHealth: vi.fn(async () => undefined),
    finalizePair: vi.fn(async () => undefined),
    cleanupOnFail: vi.fn(async () => undefined),
    client: mockClient(),
    now: () => 1_000_000,
    scheduleTimeout: timers.scheduleTimeout,
    clearTimeoutFn: timers.clearTimeoutFn,
    renderQr: vi.fn(async (uri: string) => `data:image/png;base64,${Buffer.from(uri).toString("base64")}`),
    ...overrides,
  };
  return { deps, fireExpiry: timers.fireExpiry };
}

/** Drain microtasks enough for the coordinator's async chain to settle. */
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("PairingCoordinator", () => {
  beforeEach(() => {
    vi.useRealTimers(); // explicit — we drive timers manually via scheduleTimeout
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("happy path: startLink returns uri → render QR → finishLink resolves → finalize", async () => {
    let releaseFinish: ((v: { number: string }) => void) | undefined;
    const finishLink = vi.fn(
      (params: { deviceLinkUri: string; signal?: AbortSignal }) =>
        new Promise<{ number: string }>((resolve, reject) => {
          releaseFinish = resolve;
          params.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        }),
    );
    const { deps } = makeDepsWithTimers({
      client: mockClient({
        startLink: vi.fn(async () => ({ deviceLinkUri: "sgnl://linkdevice?happy=1" })),
        finishLink,
      }),
    });
    const coord = new PairingCoordinator("u_abc", deps);

    await coord.startPair();
    expect(coord.state).toBe("awaitingScan");
    expect(coord.getQrDataUrl()).toBe(
      `data:image/png;base64,${Buffer.from("sgnl://linkdevice?happy=1").toString("base64")}`,
    );
    expect(finishLink).toHaveBeenCalledWith({
      deviceLinkUri: "sgnl://linkdevice?happy=1",
      deviceName: "Sentient-u_abc",
      signal: expect.any(AbortSignal),
    });

    // Simulate the phone scanning + confirming — daemon-side finishLink unblocks.
    releaseFinish?.({ number: "+15551234567" });
    await settle();
    expect(coord.state).toBe("linked");
    expect(deps.finalizePair).toHaveBeenCalledWith("+15551234567");
  });

  test("cancel during awaitingScan aborts in-flight finishLink → idle, no finalize", async () => {
    let abortedSignal: AbortSignal | undefined;
    const finishLink = vi.fn(
      (params: { deviceLinkUri: string; signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortedSignal = params.signal;
          params.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        }) as Promise<{ number: string }>,
    );
    const { deps } = makeDepsWithTimers({ client: mockClient({ finishLink }) });
    const coord = new PairingCoordinator("u_abc", deps);
    await coord.startPair();
    expect(coord.state).toBe("awaitingScan");
    await coord.cancel();
    expect(coord.state).toBe("idle");
    expect(abortedSignal?.aborted).toBe(true);
    expect(deps.finalizePair).not.toHaveBeenCalled();
    expect(deps.cleanupOnFail).toHaveBeenCalled();
  });

  test("5-minute expiry while awaitingScan → failed", async () => {
    const finishLink = vi.fn(
      (params: { deviceLinkUri: string; signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        }) as Promise<{ number: string }>,
    );
    const { deps, fireExpiry } = makeDepsWithTimers({ client: mockClient({ finishLink }) });
    const coord = new PairingCoordinator("u_abc", deps);
    await coord.startPair();
    expect(coord.state).toBe("awaitingScan");
    fireExpiry();
    await settle();
    expect(coord.state).toBe("failed");
    expect(coord.error).toContain("expired");
  });

  test("provisioning failure → failed with cleanup", async () => {
    const { deps } = makeDepsWithTimers({
      provisionSignalCli: vi.fn(async () => {
        throw new Error("supervisor reread failed");
      }),
    });
    const coord = new PairingCoordinator("u_abc", deps);
    await coord.startPair();
    expect(coord.state).toBe("failed");
    expect(deps.cleanupOnFail).toHaveBeenCalled();
  });

  test("finishLink rejection (daemon error) → failed with cleanup", async () => {
    const { deps } = makeDepsWithTimers({
      client: mockClient({
        finishLink: vi.fn(async () => {
          throw new Error("daemon link timeout");
        }),
      }),
    });
    const coord = new PairingCoordinator("u_abc", deps);
    await coord.startPair();
    await settle();
    expect(coord.state).toBe("failed");
    expect(coord.error).toContain("finishLink");
    expect(deps.cleanupOnFail).toHaveBeenCalled();
  });

  test("finalize failure → failed with cleanup", async () => {
    const { deps } = makeDepsWithTimers({
      finalizePair: vi.fn(async () => {
        throw new Error("apply failed");
      }),
    });
    const coord = new PairingCoordinator("u_abc", deps);
    await coord.startPair();
    await settle();
    expect(coord.state).toBe("failed");
    expect(deps.cleanupOnFail).toHaveBeenCalled();
  });

  test("getQrDataUrl returns the rendered data URL only during awaitingScan", async () => {
    const finishLink = vi.fn(
      (params: { deviceLinkUri: string; signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        }) as Promise<{ number: string }>,
    );
    const { deps } = makeDepsWithTimers({ client: mockClient({ finishLink }) });
    const coord = new PairingCoordinator("u_abc", deps);
    expect(coord.getQrDataUrl()).toBeUndefined();
    await coord.startPair();
    expect(coord.getQrDataUrl()).toMatch(/^data:image\/png;base64,/);
  });

  test("cannot startPair while awaitingScan", async () => {
    const finishLink = vi.fn(
      (params: { deviceLinkUri: string; signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
        }) as Promise<{ number: string }>,
    );
    const { deps } = makeDepsWithTimers({ client: mockClient({ finishLink }) });
    const coord = new PairingCoordinator("u_abc", deps);
    await coord.startPair();
    expect(coord.state).toBe("awaitingScan");
    await expect(coord.startPair()).rejects.toThrow(/in progress|conflict/i);
  });
});
