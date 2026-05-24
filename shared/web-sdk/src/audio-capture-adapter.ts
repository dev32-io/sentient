/** Platform-specific audio capture (mic). Implemented per platform (web, mobile). */
export interface AudioCaptureAdapter {
  /** Request mic permissions and start capturing. */
  start(): Promise<void>;
  /** Stop capturing and release mic. */
  stop(): void;
  /** Register handler for PCM16 audio chunks. Returns unsubscribe. */
  onAudioData(handler: (data: ArrayBuffer) => void): () => void;
  /** Register handler for errors. Returns unsubscribe. */
  onError(handler: (message: string) => void): () => void;
}
