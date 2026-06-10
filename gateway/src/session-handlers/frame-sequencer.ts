/**
 * FrameSequencer — stamps seq+epoch on outbound JSON frames, prepends a
 * 9-byte header on outbound binary frames, and stores wire-ready bytes in
 * the SessionReplayBuffer for byte-identical replay on reconnect.
 *
 * Header layout (binary): [8B big-endian u64 seq][1B type][payload]
 * JSON frames carry `seq` and `epoch` as top-level fields.
 * epoch is NOT included in the binary header — the client learns it from the
 * connect/ready JSON frame.
 */

import type { SessionReplayBuffer } from "./session-replay-buffer.js";

/** Binary frame type for audio payloads. */
export const BINARY_TYPE_AUDIO = 0x01;

const HEADER_BYTES = 9; // [8B BE u64 seq][1B type]

export interface FrameSequencer {
  json(frame: Record<string, unknown>): void;
  binary(payload: Uint8Array, type: number): void;
}

export interface FrameSequencerDeps {
  epoch: number;
  buffer: SessionReplayBuffer;
  sendText: (s: string) => void;
  sendBinary: (b: Uint8Array) => void;
}

export function createFrameSequencer(deps: FrameSequencerDeps): FrameSequencer {
  const { epoch, buffer, sendText, sendBinary } = deps;
  const enc = new TextEncoder();

  return {
    json(frame: Record<string, unknown>): void {
      const seq = buffer.nextSeq();
      const text = JSON.stringify({ ...frame, seq, epoch });
      buffer.store(seq, enc.encode(text), "text");
      sendText(text);
    },

    binary(payload: Uint8Array, type: number): void {
      const seq = buffer.nextSeq();
      const framed = new Uint8Array(HEADER_BYTES + payload.byteLength);
      new DataView(framed.buffer).setBigUint64(0, BigInt(seq));
      framed[8] = type;
      framed.set(payload, HEADER_BYTES);
      buffer.store(seq, framed, "binary");
      sendBinary(framed);
    },
  };
}
