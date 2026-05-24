/** Platform-specific audio playback (speakers). Implemented per platform. */
export interface AudioPlaybackAdapter {
  /** Initialize audio output (may require user gesture on web). */
  init(): Promise<boolean>;
  /** Enqueue Float32 audio samples for playback. */
  enqueue(samples: Float32Array): void;
  /** Clear all queued audio (for barge-in). */
  clear(): void;
  /** Release audio resources. */
  destroy(): void;
  /** Register handler for playback state changes. Returns unsubscribe. */
  onStateChange(handler: (playing: boolean) => void): () => void;
  /**
   * Register a one-shot handler that fires once all enqueued audio has
   * physically drained from the output pipeline. Fires after the last
   * scheduled buffer ends AND no new enqueue has arrived in one audio frame.
   * Cleared by `clear()`. Returns unsubscribe.
   */
  onDrain(handler: () => void): () => void;
}
