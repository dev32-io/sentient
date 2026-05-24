export type FramePriority = 1 | 2;

/** SystemFrames — priority 1, always processed first */
export interface InterruptionFrame {
  kind: "system";
  type: "interruption";
  sessionId: string;
  timestamp: number;
}

export interface ConfigFrame {
  kind: "system";
  type: "config";
  key: string;
  value: unknown;
}

export type SystemFrame = InterruptionFrame | ConfigFrame;

/** DataFrames — priority 2, ordered, cancellable */
export interface AudioFrame {
  kind: "data";
  type: "audio";
  data: Uint8Array;
  encoding: "opus" | "pcm16";
  sampleRate: number;
}

export interface TextFrame {
  kind: "data";
  type: "text";
  text: string;
  isFinal: boolean;
}

export interface TranscriptFrame {
  kind: "data";
  type: "transcript";
  text: string;
  isFinal: boolean;
  confidence: number;
}

export type DataFrame = AudioFrame | TextFrame | TranscriptFrame;

/** ControlFrames — priority 2, ordered */
export interface StartFrame {
  kind: "control";
  type: "start";
  sessionId: string;
}

export interface StopFrame {
  kind: "control";
  type: "stop";
  sessionId: string;
  reason: string;
}

export type ControlFrame = StartFrame | StopFrame;

export type Frame = SystemFrame | DataFrame | ControlFrame;

export function framePriority(frame: Frame): FramePriority {
  return frame.kind === "system" ? 1 : 2;
}

export function isSystemFrame(frame: Frame): frame is SystemFrame {
  return frame.kind === "system";
}

export function isDataFrame(frame: Frame): frame is DataFrame {
  return frame.kind === "data";
}
