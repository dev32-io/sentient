/**
 * S2 (hold/toggle-talk split, 2026-07-17 design §4/§6) — wire-contract pin:
 * `audio.start`'s `turnMode` field must reach the STT relay via
 * `ws.data.audioAdapter.setTurnMode()`. zod defaults `turnMode` to
 * "semantic" when the client omits it, so this also pins back-compat for
 * old clients / webui that never send the field.
 */

import type { ServerWebSocket } from "bun";
import { describe, expect, it, vi } from "vitest";
import type { UserAudioInputAdapter } from "../adapters/user-audio-input-adapter.js";
import type { GatewayServices } from "../bootstrap/create-gateway-services.js";
import { handleWebSocketMessage } from "./ws-handlers.js";
import { createEmptySessionData } from "./ws-helpers.js";
import type { ClientData } from "./ws-helpers.js";

function makeFakeAudioAdapter(): UserAudioInputAdapter & { setTurnMode: ReturnType<typeof vi.fn> } {
  return {
    id: "fake-audio-adapter",
    eventKinds: [],
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendAudioFrame: vi.fn(),
    suppressInputFor: vi.fn(),
    endUtterance: vi.fn(),
    reconfigure: vi.fn().mockResolvedValue(undefined),
    setOnSpeechOnset: vi.fn(),
    setTurnMode: vi.fn(),
  };
}

function makeWs(audioAdapter: UserAudioInputAdapter): ServerWebSocket<ClientData> {
  const data = createEmptySessionData();
  data.authState = "authed";
  data.audioAdapter = audioAdapter;
  return {
    data,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as ServerWebSocket<ClientData>;
}

function makeServices(): GatewayServices {
  return {} as unknown as GatewayServices;
}

describe("handleWebSocketMessage — audio.start turnMode relay", () => {
  it("relays turnMode=manual to the audio adapter", async () => {
    const audioAdapter = makeFakeAudioAdapter();
    const ws = makeWs(audioAdapter);

    await handleWebSocketMessage(ws, JSON.stringify({ type: "audio.start", turnMode: "manual" }), makeServices());

    expect(audioAdapter.setTurnMode).toHaveBeenCalledOnce();
    expect(audioAdapter.setTurnMode).toHaveBeenCalledWith("manual");
    expect(ws.data.isStreaming).toBe(true);
  });

  it("relays the zod-defaulted turnMode=semantic when the client omits the field", async () => {
    const audioAdapter = makeFakeAudioAdapter();
    const ws = makeWs(audioAdapter);

    await handleWebSocketMessage(ws, JSON.stringify({ type: "audio.start" }), makeServices());

    expect(audioAdapter.setTurnMode).toHaveBeenCalledOnce();
    expect(audioAdapter.setTurnMode).toHaveBeenCalledWith("semantic");
  });

  it("does not throw when no audio adapter is attached yet", async () => {
    const ws = makeWs(null as unknown as UserAudioInputAdapter);
    ws.data.audioAdapter = null;

    await expect(
      handleWebSocketMessage(ws, JSON.stringify({ type: "audio.start", turnMode: "manual" }), makeServices()),
    ).resolves.toBeUndefined();
  });
});
