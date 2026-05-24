// Structurally compatible with CaptureAdapter and PlaybackAdapter from web-sdk.
// Defined locally to avoid cross-package coupling from the testing package.

export interface MockCaptureAdapter {
  start(): Promise<void>;
  stop(): void;
  onAudioData(handler: (data: ArrayBuffer) => void): () => void;
  onError(handler: (message: string) => void): () => void;

  // Test control
  simulateAudioData(data: ArrayBuffer): void;
  simulateError(message: string): void;
}

export interface MockPlaybackAdapter {
  init(): Promise<boolean>;
  enqueue(samples: Float32Array): void;
  clear(): void;
  destroy(): void;
  onStateChange(handler: (playing: boolean) => void): () => void;

  // Test control
  enqueuedSamples(): Float32Array[];
  wasCleared(): boolean;
  resetCleared(): void;
}

export function createMockCaptureAdapter(): MockCaptureAdapter {
  let audioDataHandler: ((data: ArrayBuffer) => void) | null = null;
  let errorHandler: ((message: string) => void) | null = null;

  async function start(): Promise<void> {}

  function stop(): void {}

  function onAudioData(handler: (data: ArrayBuffer) => void): () => void {
    audioDataHandler = handler;
    return () => {
      audioDataHandler = null;
    };
  }

  function onError(handler: (message: string) => void): () => void {
    errorHandler = handler;
    return () => {
      errorHandler = null;
    };
  }

  function simulateAudioData(data: ArrayBuffer): void {
    audioDataHandler?.(data);
  }

  function simulateError(message: string): void {
    errorHandler?.(message);
  }

  return {
    start,
    stop,
    onAudioData,
    onError,
    simulateAudioData,
    simulateError,
  };
}

export function createMockPlaybackAdapter(): MockPlaybackAdapter {
  const enqueued: Float32Array[] = [];
  let cleared = false;
  let stateChangeHandler: ((playing: boolean) => void) | null = null;
  let isPlaying = false;

  async function init(): Promise<boolean> {
    return true;
  }

  function enqueue(samples: Float32Array): void {
    enqueued.push(samples);
    if (!isPlaying) {
      isPlaying = true;
      stateChangeHandler?.(true);
    }
  }

  function clear(): void {
    cleared = true;
    enqueued.length = 0;
    if (isPlaying) {
      isPlaying = false;
      stateChangeHandler?.(false);
    }
  }

  function destroy(): void {}

  function onStateChange(handler: (playing: boolean) => void): () => void {
    stateChangeHandler = handler;
    return () => {
      stateChangeHandler = null;
    };
  }

  function enqueuedSamples(): Float32Array[] {
    return enqueued;
  }

  function wasCleared(): boolean {
    return cleared;
  }

  function resetCleared(): void {
    cleared = false;
  }

  return {
    init,
    enqueue,
    clear,
    destroy,
    onStateChange,
    enqueuedSamples,
    wasCleared,
    resetCleared,
  };
}
