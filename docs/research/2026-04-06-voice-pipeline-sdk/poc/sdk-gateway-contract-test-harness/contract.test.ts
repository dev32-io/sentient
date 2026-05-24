import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  clientMessageSchema,
  gatewayMessageSchema,
  contractErrorSchema,
  encodeClientMessage,
  encodeAudioChunk,
  decodeWireMessage,
  decodeClientWireMessage,
  createProtocolValidator,
  createMockTransport,
  ERROR_CODES,
  type ClientMessage,
  type GatewayMessage,
  type WireMessage,
} from "./contract";

// ─── Helpers ───

const uuid = () => randomUUID();

function gwMsg(msg: GatewayMessage): WireMessage {
  return { wsType: "text", data: JSON.stringify(msg) };
}

// ─── 1. Message Schema Validation ───

describe("Client message validation", () => {
  it("accepts valid utterance.start", () => {
    const id = uuid();
    const result = clientMessageSchema.safeParse({
      type: "utterance.start",
      utteranceId: id,
    });
    expect(result.success).toBe(true);
  });

  it("rejects utterance.start without UUID", () => {
    const result = clientMessageSchema.safeParse({
      type: "utterance.start",
      utteranceId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects utterance.start without utteranceId", () => {
    const result = clientMessageSchema.safeParse({
      type: "utterance.start",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid session.configure", () => {
    const result = clientMessageSchema.safeParse({
      type: "session.configure",
      mode: "continuous",
      encoding: "pcm16",
      sampleRate: 48000,
      capabilities: ["vad", "barge-in"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects session.configure with invalid mode", () => {
    const result = clientMessageSchema.safeParse({
      type: "session.configure",
      mode: "auto",
      encoding: "pcm16",
      sampleRate: 48000,
      capabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects session.configure with negative sampleRate", () => {
    const result = clientMessageSchema.safeParse({
      type: "session.configure",
      mode: "continuous",
      encoding: "pcm16",
      sampleRate: -1,
      capabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid barge_in with responseId", () => {
    const result = clientMessageSchema.safeParse({
      type: "barge_in",
      responseId: uuid(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid text.input", () => {
    const result = clientMessageSchema.safeParse({
      type: "text.input",
      text: "hello there",
    });
    expect(result.success).toBe(true);
  });

  it("rejects text.input with empty text", () => {
    const result = clientMessageSchema.safeParse({
      type: "text.input",
      text: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown message type", () => {
    const result = clientMessageSchema.safeParse({
      type: "unknown.msg",
    });
    expect(result.success).toBe(false);
  });
});

describe("Gateway message validation", () => {
  it("accepts valid session.created", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "session.created",
      sessionId: "sess-1",
      protocol: "sentient-voice-v1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid transcript.partial with utteranceId", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "transcript.partial",
      utteranceId: uuid(),
      text: "hel",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid response.start with both IDs", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "response.start",
      utteranceId: uuid(),
      responseId: uuid(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid barge_in.ack with truncatedText", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "barge_in.ack",
      responseId: uuid(),
      truncatedText: "I was saying...",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid response.done", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "response.done",
      responseId: uuid(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts session.ended with valid reason", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "session.ended",
      reason: "client_request",
    });
    expect(result.success).toBe(true);
  });

  it("rejects session.ended with invalid reason", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "session.ended",
      reason: "unknown_reason",
    });
    expect(result.success).toBe(false);
  });
});

// ─── 2. Error Code Validation ───

describe("Error contract", () => {
  it("validates error with all fields", () => {
    const result = contractErrorSchema.safeParse({
      type: "error",
      code: "provider_error",
      message: "Something went wrong",
      utteranceId: uuid(),
      recoverable: true,
    });
    expect(result.success).toBe(true);
  });

  it("validates error without optional scoping IDs", () => {
    const result = contractErrorSchema.safeParse({
      type: "error",
      code: "auth_failed",
      message: "Invalid token",
      recoverable: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects free-form error code (fixes current bug)", () => {
    const result = contractErrorSchema.safeParse({
      type: "error",
      code: "stt_error", // current codebase sends this — NOT in the enum
      message: "STT failed",
      recoverable: true,
    });
    expect(result.success).toBe(false);
  });

  it("requires recoverable field (not in current codebase)", () => {
    const result = contractErrorSchema.safeParse({
      type: "error",
      code: "provider_error",
      message: "Temporary failure",
      // missing recoverable
    });
    expect(result.success).toBe(false);
  });

  it("all error codes are enumerated", () => {
    expect(ERROR_CODES).toContain("auth_failed");
    expect(ERROR_CODES).toContain("provider_error");
    expect(ERROR_CODES).toContain("utterance_failed");
    expect(ERROR_CODES).toContain("rate_limited");
    expect(ERROR_CODES.length).toBe(8);
  });
});

// ─── 3. Binary/JSON Muxing ───

describe("Binary/JSON mux", () => {
  it("encodes client JSON messages as text WS frames", () => {
    const msg: ClientMessage = { type: "utterance.start", utteranceId: uuid() };
    const wire = encodeClientMessage(msg);
    expect(wire.wsType).toBe("text");
    expect(typeof wire.data).toBe("string");
    const parsed = JSON.parse(wire.data as string);
    expect(parsed.type).toBe("utterance.start");
  });

  it("encodes audio as binary WS frames", () => {
    const pcm = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const wire = encodeAudioChunk(pcm);
    expect(wire.wsType).toBe("binary");
    expect(wire.data).toBeInstanceOf(Uint8Array);
    expect(wire.data).toEqual(pcm);
  });

  it("decodes text WS frames as gateway JSON messages", () => {
    const responseId = uuid();
    const wire: WireMessage = {
      wsType: "text",
      data: JSON.stringify({ type: "response.done", responseId }),
    };
    const decoded = decodeWireMessage(wire);
    expect(decoded).not.toBeInstanceOf(Uint8Array);
    expect((decoded as GatewayMessage).type).toBe("response.done");
  });

  it("decodes binary WS frames as raw audio", () => {
    const pcm = new Uint8Array([10, 20, 30]);
    const wire: WireMessage = { wsType: "binary", data: pcm };
    const decoded = decodeWireMessage(wire);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded).toEqual(pcm);
  });

  it("rejects invalid JSON in text frames", () => {
    const wire: WireMessage = { wsType: "text", data: "not valid json" };
    expect(() => decodeWireMessage(wire)).toThrow();
  });

  it("rejects JSON with unknown message type in text frames", () => {
    const wire: WireMessage = {
      wsType: "text",
      data: JSON.stringify({ type: "fake.message" }),
    };
    expect(() => decodeWireMessage(wire)).toThrow();
  });

  it("round-trips client messages through encode/decode", () => {
    const msg: ClientMessage = {
      type: "session.configure",
      mode: "continuous",
      encoding: "opus",
      sampleRate: 48000,
      capabilities: ["vad"],
    };
    const wire = encodeClientMessage(msg);
    const decoded = decodeClientWireMessage(wire);
    expect(decoded).not.toBeInstanceOf(Uint8Array);
    expect(decoded).toEqual(msg);
  });
});

// ─── 4. Protocol Sequence Validation ───

describe("Protocol sequence — happy path", () => {
  it("validates a full session lifecycle with zero errors", () => {
    const v = createProtocolValidator();
    const uttId = uuid();
    const respId = uuid();

    // Session setup
    v.feed({ type: "session.created", sessionId: "s1", protocol: "sentient-voice-v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: ["vad"] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    // Utterance
    v.feed({ type: "utterance.start", utteranceId: uttId });
    v.feedBinary("client"); // audio chunk
    v.feedBinary("client");
    v.feed({ type: "transcript.partial", utteranceId: uttId, text: "hel" });
    v.feed({ type: "utterance.end", utteranceId: uttId });
    v.feed({ type: "transcript.final", utteranceId: uttId, text: "hello" });

    // Response
    v.feed({ type: "response.start", utteranceId: uttId, responseId: respId });
    v.feed({ type: "response.text.delta", responseId: respId, text: "Hi " });
    v.feed({ type: "response.text.delta", responseId: respId, text: "there!" });
    v.feed({ type: "response.audio.start", responseId: respId });
    v.feedBinary("gateway"); // TTS audio
    v.feed({ type: "response.audio.done", responseId: respId });
    v.feed({ type: "response.text.done", responseId: respId, text: "Hi there!" });
    v.feed({ type: "response.done", responseId: respId });

    // End
    v.feed({ type: "session.end" });

    expect(v.errors).toEqual([]);
    expect(v.phase).toBe("ended");
  });
});

describe("Protocol sequence — out-of-order detection", () => {
  it("catches utterance.start before session.ready", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "utterance.start", utteranceId: uuid() });
    expect(v.errors.length).toBeGreaterThan(0);
    expect(v.errors[0]).toContain("invalid phase");
  });

  it("catches double utterance.start without utterance.end", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    v.feed({ type: "utterance.start", utteranceId: uuid() });
    v.feed({ type: "utterance.start", utteranceId: uuid() }); // double start!
    expect(v.errors.some(e => e.includes("still active"))).toBe(true);
  });

  it("catches utterance.end ID mismatch", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    const id1 = uuid();
    v.feed({ type: "utterance.start", utteranceId: id1 });
    v.feed({ type: "utterance.end", utteranceId: uuid() }); // wrong ID!
    expect(v.errors.some(e => e.includes("ID mismatch"))).toBe(true);
  });

  it("catches response.text.delta outside responding phase", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    v.feed({ type: "response.text.delta", responseId: uuid(), text: "bad" });
    expect(v.errors.some(e => e.includes("outside 'responding' phase"))).toBe(true);
  });

  it("catches client binary audio outside streaming phase", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    v.feedBinary("client"); // audio before utterance.start!
    expect(v.errors.some(e => e.includes("client binary audio outside"))).toBe(true);
  });

  it("catches gateway binary audio outside responding phase", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    v.feedBinary("gateway"); // TTS audio in ready phase!
    expect(v.errors.some(e => e.includes("gateway binary audio outside"))).toBe(true);
  });

  it("catches session.configure sent twice", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    expect(v.errors.some(e => e.includes("outside 'created' phase"))).toBe(true);
  });
});

describe("Protocol sequence — barge-in", () => {
  function setupToResponding() {
    const v = createProtocolValidator();
    const uttId = uuid();
    const respId = uuid();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });
    v.feed({ type: "utterance.start", utteranceId: uttId });
    v.feed({ type: "utterance.end", utteranceId: uttId });
    v.feed({ type: "transcript.final", utteranceId: uttId, text: "hello" });
    v.feed({ type: "response.start", utteranceId: uttId, responseId: respId });
    v.feed({ type: "response.text.delta", responseId: respId, text: "Hi" });
    return { v, uttId, respId };
  }

  it("allows barge_in during responding phase", () => {
    const { v, respId } = setupToResponding();
    v.feed({ type: "barge_in", responseId: respId });
    expect(v.errors).toEqual([]);
  });

  it("barge_in.ack returns to ready phase", () => {
    const { v, respId } = setupToResponding();
    v.feed({ type: "barge_in", responseId: respId });
    v.feed({ type: "barge_in.ack", responseId: respId, truncatedText: "Hi" });
    expect(v.phase).toBe("ready");
    expect(v.errors).toEqual([]);
  });

  it("allows new utterance after barge_in.ack", () => {
    const { v, respId } = setupToResponding();
    v.feed({ type: "barge_in", responseId: respId });
    v.feed({ type: "barge_in.ack", responseId: respId, truncatedText: "Hi" });
    v.feed({ type: "utterance.start", utteranceId: uuid() });
    expect(v.phase).toBe("streaming");
    expect(v.errors).toEqual([]);
  });

  it("catches barge_in outside responding phase", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });
    v.feed({ type: "barge_in", responseId: uuid() });
    expect(v.errors.some(e => e.includes("outside 'responding' phase"))).toBe(true);
  });
});

describe("Protocol sequence — multi-turn conversation", () => {
  it("supports multiple utterance-response cycles", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    for (let i = 0; i < 5; i++) {
      const uttId = uuid();
      const respId = uuid();
      v.feed({ type: "utterance.start", utteranceId: uttId });
      v.feedBinary("client");
      v.feed({ type: "utterance.end", utteranceId: uttId });
      v.feed({ type: "transcript.final", utteranceId: uttId, text: `turn ${i}` });
      v.feed({ type: "response.start", utteranceId: uttId, responseId: respId });
      v.feed({ type: "response.text.delta", responseId: respId, text: `reply ${i}` });
      v.feed({ type: "response.done", responseId: respId });
    }

    expect(v.errors).toEqual([]);
    expect(v.phase).toBe("ready");
  });

  it("supports partial transcripts interleaved during streaming", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    const uttId = uuid();
    v.feed({ type: "utterance.start", utteranceId: uttId });
    v.feedBinary("client");
    v.feed({ type: "transcript.partial", utteranceId: uttId, text: "hel" });
    v.feedBinary("client");
    v.feed({ type: "transcript.partial", utteranceId: uttId, text: "hello" });
    v.feed({ type: "utterance.end", utteranceId: uttId });
    v.feed({ type: "transcript.final", utteranceId: uttId, text: "hello world" });

    expect(v.errors).toEqual([]);
  });
});

// ─── 5. Mock Transport ───

describe("Mock transport", () => {
  it("records client-sent messages", () => {
    const transport = createMockTransport();
    const msg: ClientMessage = { type: "utterance.start", utteranceId: uuid() };
    transport.clientSend(encodeClientMessage(msg));
    expect(transport.clientSent.length).toBe(1);
    expect(transport.clientSent[0].wsType).toBe("text");
  });

  it("records gateway-sent messages", () => {
    const transport = createMockTransport();
    transport.gatewaySend(gwMsg({ type: "pong" }));
    expect(transport.gatewaySent.length).toBe(1);
  });

  it("fires onClientMessage callback", () => {
    const transport = createMockTransport();
    const received: WireMessage[] = [];
    transport.onClientMessage = (msg) => received.push(msg);
    transport.clientSend(encodeAudioChunk(new Uint8Array([1, 2, 3])));
    expect(received.length).toBe(1);
    expect(received[0].wsType).toBe("binary");
  });

  it("fires onGatewayMessage callback", () => {
    const transport = createMockTransport();
    const received: WireMessage[] = [];
    transport.onGatewayMessage = (msg) => received.push(msg);
    transport.gatewaySend(gwMsg({ type: "session.created", sessionId: "s1", protocol: "v1" }));
    expect(received.length).toBe(1);
  });
});

// ─── 6. End-to-End Mock Session (transport + validator) ───

describe("End-to-end mock session", () => {
  it("full session through mock transport with protocol validation", () => {
    const transport = createMockTransport();
    const validator = createProtocolValidator();
    const uttId = uuid();
    const respId = uuid();

    // Wire transport to validator
    transport.onClientMessage = (wire) => {
      if (wire.wsType === "binary") {
        validator.feedBinary("client");
      } else {
        const msg = decodeClientWireMessage(wire);
        if (!(msg instanceof Uint8Array)) validator.feed(msg);
      }
    };
    transport.onGatewayMessage = (wire) => {
      if (wire.wsType === "binary") {
        validator.feedBinary("gateway");
      } else {
        const msg = decodeWireMessage(wire);
        if (!(msg instanceof Uint8Array)) validator.feed(msg as GatewayMessage);
      }
    };

    // Simulate session
    transport.gatewaySend(gwMsg({ type: "session.created", sessionId: "s1", protocol: "sentient-voice-v1" }));
    transport.clientSend(encodeClientMessage({
      type: "session.configure",
      mode: "continuous",
      encoding: "pcm16",
      sampleRate: 48000,
      capabilities: ["vad", "barge-in"],
    }));
    transport.gatewaySend(gwMsg({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 }));

    // Utterance
    transport.clientSend(encodeClientMessage({ type: "utterance.start", utteranceId: uttId }));
    transport.clientSend(encodeAudioChunk(new Uint8Array(960))); // ~20ms of PCM16
    transport.clientSend(encodeAudioChunk(new Uint8Array(960)));
    transport.clientSend(encodeClientMessage({ type: "utterance.end", utteranceId: uttId }));

    // Transcripts
    transport.gatewaySend(gwMsg({ type: "transcript.partial", utteranceId: uttId, text: "what" }));
    transport.gatewaySend(gwMsg({ type: "transcript.final", utteranceId: uttId, text: "what time is it" }));

    // Response
    transport.gatewaySend(gwMsg({ type: "response.start", utteranceId: uttId, responseId: respId }));
    transport.gatewaySend(gwMsg({ type: "response.text.delta", responseId: respId, text: "It's " }));
    transport.gatewaySend(gwMsg({ type: "response.text.delta", responseId: respId, text: "3pm." }));
    transport.gatewaySend(gwMsg({ type: "response.audio.start", responseId: respId }));
    transport.gatewaySend({ wsType: "binary", data: new Uint8Array(4410) }); // TTS audio
    transport.gatewaySend(gwMsg({ type: "response.audio.done", responseId: respId }));
    transport.gatewaySend(gwMsg({ type: "response.text.done", responseId: respId, text: "It's 3pm." }));
    transport.gatewaySend(gwMsg({ type: "response.done", responseId: respId }));

    // Session end
    transport.clientSend(encodeClientMessage({ type: "session.end" }));

    // Validate
    expect(validator.errors).toEqual([]);
    expect(validator.phase).toBe("ended");
    // session.configure + utterance.start + 2 audio + utterance.end + session.end = 6
    expect(transport.clientSent.length).toBe(6);
    // session.created + session.ready + partial + final + response.start + 2 text.delta + audio.start + audio(binary) + audio.done + text.done + response.done = 12
    expect(transport.gatewaySent.length).toBe(12);
  });
});

// ─── 7. Correlation ID Consistency ───

describe("Correlation ID tracking", () => {
  it("utteranceId links utterance → transcript → response chain", () => {
    const uttId = uuid();
    const respId = uuid();

    // All messages in the chain share the same utteranceId
    const chain: (ClientMessage | GatewayMessage)[] = [
      { type: "utterance.start", utteranceId: uttId },
      { type: "utterance.end", utteranceId: uttId },
      { type: "transcript.partial", utteranceId: uttId, text: "hel" },
      { type: "transcript.final", utteranceId: uttId, text: "hello" },
      { type: "response.start", utteranceId: uttId, responseId: respId },
    ];

    for (const msg of chain) {
      if ("utteranceId" in msg) {
        expect(msg.utteranceId).toBe(uttId);
      }
    }
  });

  it("responseId links response events", () => {
    const respId = uuid();
    const responseChain: GatewayMessage[] = [
      { type: "response.start", utteranceId: uuid(), responseId: respId },
      { type: "response.text.delta", responseId: respId, text: "Hi" },
      { type: "response.audio.start", responseId: respId },
      { type: "response.audio.done", responseId: respId },
      { type: "response.text.done", responseId: respId, text: "Hi there" },
      { type: "response.done", responseId: respId },
    ];

    for (const msg of responseChain) {
      if ("responseId" in msg) {
        expect(msg.responseId).toBe(respId);
      }
    }
  });

  it("barge_in.ack references the interrupted response", () => {
    const respId = uuid();
    const ack: GatewayMessage = {
      type: "barge_in.ack",
      responseId: respId,
      truncatedText: "I was say...",
    };
    expect(ack.responseId).toBe(respId);
    expect(ack.truncatedText).toBe("I was say...");
  });
});

// ─── 8. Provider Leakage Detection ───

describe("Provider leakage — contract messages contain no provider details", () => {
  it("transcript messages carry no provider-specific fields", () => {
    const msg = gatewayMessageSchema.parse({
      type: "transcript.final",
      utteranceId: uuid(),
      text: "hello",
    });
    // Should NOT have confidence, isFinal, speechFinal — those are Deepgram internals
    expect(msg).not.toHaveProperty("confidence");
    expect(msg).not.toHaveProperty("isFinal");
    expect(msg).not.toHaveProperty("speechFinal");
  });

  it("session.ready carries no provider-specific config", () => {
    const msg = gatewayMessageSchema.parse({
      type: "session.ready",
      encoding: "pcm16",
      sampleRate: 48000,
    });
    // Should NOT have endpointingMs, utteranceEndMs, keepAliveIntervalMs — STT provider config
    expect(msg).not.toHaveProperty("endpointingMs");
    expect(msg).not.toHaveProperty("utteranceEndMs");
    expect(msg).not.toHaveProperty("model");
  });

  it("error messages use contract error codes, not provider error strings", () => {
    // Validates the fix for voice-handlers.ts sending "stt_error" (not in enum)
    expect(() => contractErrorSchema.parse({
      type: "error",
      code: "stt_error",
      message: "fail",
      recoverable: true,
    })).toThrow();

    // The correct code should be "provider_error" — gateway maps internally
    expect(() => contractErrorSchema.parse({
      type: "error",
      code: "provider_error",
      message: "Speech recognition failed",
      recoverable: true,
    })).not.toThrow();
  });
});

// ─── 9. Edge Cases ───

describe("Edge cases", () => {
  it("ping/pong allowed in any protocol phase", () => {
    const v = createProtocolValidator();
    // Even before session.created
    v.feed({ type: "ping" });
    v.feed({ type: "pong" });
    expect(v.errors).toEqual([]);

    // After session setup
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "ping" });
    v.feed({ type: "pong" });
    expect(v.errors).toEqual([]);
  });

  it("error messages allowed in any protocol phase", () => {
    const v = createProtocolValidator();
    v.feed({
      type: "error",
      code: "provider_error",
      message: "Internal issue",
      recoverable: true,
    } as any);
    expect(v.errors).toEqual([]);
  });

  it("text.input requires ready phase", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "text.input", text: "hello" });
    expect(v.errors.some(e => e.includes("outside 'ready' phase"))).toBe(true);
  });

  it("text.input works in ready phase", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });
    v.feed({ type: "text.input", text: "hello" });
    expect(v.errors).toEqual([]);
  });

  it("immediate barge-in: utterance.start during responding triggers transition", () => {
    const v = createProtocolValidator();
    v.feed({ type: "session.created", sessionId: "s1", protocol: "v1" });
    v.feed({ type: "session.configure", mode: "continuous", encoding: "pcm16", sampleRate: 48000, capabilities: [] });
    v.feed({ type: "session.ready", encoding: "pcm16", sampleRate: 48000 });

    const uttId = uuid();
    const respId = uuid();
    v.feed({ type: "utterance.start", utteranceId: uttId });
    v.feed({ type: "utterance.end", utteranceId: uttId });
    v.feed({ type: "transcript.final", utteranceId: uttId, text: "hello" });
    v.feed({ type: "response.start", utteranceId: uttId, responseId: respId });

    // User speaks during response — contract allows this as barge-in trigger
    v.feed({ type: "utterance.start", utteranceId: uuid() });
    expect(v.phase).toBe("streaming");
    expect(v.errors).toEqual([]);
  });
});
