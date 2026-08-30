import { describe, expect, it } from "bun:test";
import { configure, reset } from "@logtape/logtape";
import { createLoggingTurnEmitter } from "./turn-emitter.ts";

describe("createLoggingTurnEmitter", () => {
  it("records lifecycle aggregates without text, argument values, or per-frame logs", async () => {
    const records: Array<{ message: string; properties: Record<string, unknown> }> = [];
    await configure({
      sinks: {
        test: (record) => records.push({ message: record.message.map(String).join(""), properties: record.properties }),
      },
      loggers: [
        { category: ["sentient", "runtime", "turn-emitter"], sinks: ["test"], lowestLevel: "debug" },
        { category: "logtape", sinks: [], lowestLevel: "error" },
      ],
      reset: true,
    });

    const sensitiveText = "PRIVATE_ASSISTANT_TEXT";
    const sensitiveArgument = "PRIVATE_TOOL_ARGUMENT";
    try {
      const emitter = createLoggingTurnEmitter();
      emitter.turnStarted("turn-1", "user");
      emitter.textDelta("turn-1", sensitiveText, "reply-1");
      emitter.turnCompleted("turn-1");
      emitter.audioStart("turn-1", "opus", 48000);
      emitter.audioFrame("turn-1", new Uint8Array([1, 2, 3]));
      emitter.audioFrame("turn-1", new Uint8Array([4, 5]));
      emitter.audioDone("turn-1");
      emitter.audioStart("turn-cancelled", "opus", 48000);
      emitter.audioFrame("turn-cancelled", new Uint8Array([9, 9, 9]));
      emitter.playbackStop("turn-cancelled", "interrupt");
      emitter.audioDone("turn-cancelled");
      emitter.permissionRequest({
        requestId: "request-1",
        toolCallId: "call-1",
        toolName: "example",
        args: { [sensitiveArgument]: sensitiveText },
        description: sensitiveText,
        expiresAtMs: 1000,
      });

      expect(records.find((record) => record.message === "turn-emitter.turn-completed")?.properties).toEqual({
        turnId: "turn-1",
        textChunkCount: 1,
        textChars: sensitiveText.length,
      });
      expect(records.some((record) => record.message === "turn-emitter.text-delta")).toBe(false);
      expect(records.find((record) => record.message === "turn-emitter.audio-done")?.properties).toEqual({
        turnId: "turn-1",
        frameCount: 2,
        audioBytes: 5,
      });
      expect(
        records.find(
          (record) => record.message === "turn-emitter.audio-done" && record.properties.turnId === "turn-cancelled",
        )?.properties,
      ).toEqual({ turnId: "turn-cancelled", frameCount: 0, audioBytes: 0 });
      expect(records.some((record) => record.message === "turn-emitter.audio-frame")).toBe(false);
      expect(JSON.stringify(records)).not.toContain(sensitiveText);
      expect(JSON.stringify(records)).not.toContain(sensitiveArgument);
    } finally {
      await reset();
    }
  });
});
