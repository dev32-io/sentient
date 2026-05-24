/**
 * Raw WebSocket + MessagePack client for Fish Audio TTS.
 * No SDK — implements the streaming protocol directly.
 * Designed for Bun runtime.
 */

import { encode, decode } from '@msgpack/msgpack';

export interface FishAudioConfig {
  apiKey: string;
  endpoint?: string;
  model?: string;
  voiceId: string;
  format?: 'opus' | 'pcm' | 'mp3';
  sampleRate?: number;
  bitrate?: number;
  latencyMode?: 'normal' | 'balanced' | 'low';
}

export interface FishAudioSession {
  synthesize(sentences: AsyncGenerator<string>): AsyncGenerator<Uint8Array>;
  close(): Promise<void>;
  readonly state: 'connecting' | 'open' | 'closing' | 'closed';
}

// Fish Audio MessagePack event types
interface StartEvent {
  event: 'start';
  request: {
    model_id: string;
    text: string;
    format: string;
    sample_rate: number;
    bitrate?: number;
    latency?: string;
    streaming?: boolean;
    reference_id?: string;
  };
}

interface TextEvent {
  event: 'text';
  text: string;
}

interface FlushEvent {
  event: 'flush';
}

interface StopEvent {
  event: 'stop';
}

interface AudioEvent {
  event: 'audio';
  audio: Uint8Array;
}

interface FinishEvent {
  event: 'finish';
  reason?: string;
}

type ServerEvent = AudioEvent | FinishEvent | { event: string; [key: string]: unknown };

export function createFishAudioSession(config: FishAudioConfig): FishAudioSession {
  const endpoint = config.endpoint ?? 'wss://api.fish.audio/v1/tts/live';
  const model = config.model ?? 'speech-1.5';
  const format = config.format ?? 'opus';
  const sampleRate = config.sampleRate ?? 48000;
  const bitrate = config.bitrate ?? 48;
  const latencyMode = config.latencyMode ?? 'balanced';

  let ws: WebSocket | null = null;
  let _state: 'connecting' | 'open' | 'closing' | 'closed' = 'closed';

  // Queue for received audio chunks
  let audioResolve: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  const audioQueue: Uint8Array[] = [];
  let finished = false;
  let error: Error | null = null;

  function enqueueAudio(chunk: Uint8Array) {
    if (audioResolve) {
      const resolve = audioResolve;
      audioResolve = null;
      resolve({ value: chunk, done: false });
    } else {
      audioQueue.push(chunk);
    }
  }

  function signalFinish() {
    finished = true;
    if (audioResolve) {
      const resolve = audioResolve;
      audioResolve = null;
      resolve({ value: undefined as any, done: true });
    }
  }

  function signalError(err: Error) {
    error = err;
    if (audioResolve) {
      const resolve = audioResolve;
      audioResolve = null;
      resolve({ value: undefined as any, done: true });
    }
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      _state = 'connecting';
      ws = new WebSocket(endpoint, {
        headers: {
          Authorization: "Bearer " + config.apiKey,
        },
      } as any);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        _state = 'open';

        // Send StartEvent
        const startEvt: StartEvent = {
          event: 'start',
          request: {
            model_id: model,
            text: '',
            format,
            sample_rate: sampleRate,
            bitrate,
            latency: latencyMode,
            streaming: true,
            reference_id: config.voiceId,
          },
        };
        ws!.send(encode(startEvt));
        resolve();
      };

      ws.onmessage = (event: MessageEvent) => {
        try {
          const data = event.data;
          let buf: Uint8Array;
          if (data instanceof ArrayBuffer) {
            buf = new Uint8Array(data);
          } else if (data instanceof Uint8Array) {
            buf = data;
          } else {
            return;
          }

          const msg = decode(buf) as ServerEvent;

          if (msg.event === 'audio' && (msg as AudioEvent).audio) {
            enqueueAudio(new Uint8Array((msg as AudioEvent).audio));
          } else if (msg.event === 'finish') {
            signalFinish();
          }
        } catch (e) {
          signalError(new Error("MessagePack decode error: " + e));
        }
      };

      ws.onerror = () => {
        const err = new Error('Fish Audio WebSocket error');
        signalError(err);
        if (_state === 'connecting') reject(err);
      };

      ws.onclose = () => {
        _state = 'closed';
        signalFinish();
      };
    });
  }

  const session: FishAudioSession = {
    get state() { return _state; },

    async *synthesize(sentences: AsyncGenerator<string>): AsyncGenerator<Uint8Array> {
      if (_state === 'closed') {
        await connect();
      }

      // Send text events for each sentence, concurrently yield audio
      const sendTask = (async () => {
        for await (const sentence of sentences) {
          if (!ws || ws.readyState !== WebSocket.OPEN) break;
          const textEvt: TextEvent = { event: 'text', text: sentence };
          ws.send(encode(textEvt));

          // Flush after each sentence to get audio back ASAP
          const flushEvt: FlushEvent = { event: 'flush' };
          ws.send(encode(flushEvt));
        }
        // Signal end of text input
        if (ws && ws.readyState === WebSocket.OPEN) {
          const stopEvt: StopEvent = { event: 'stop' };
          ws.send(encode(stopEvt));
        }
      })();

      // Yield audio chunks as they arrive
      while (true) {
        if (error) throw error;

        if (audioQueue.length > 0) {
          yield audioQueue.shift()!;
          continue;
        }

        if (finished) break;

        // Wait for next audio chunk
        const result = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
          audioResolve = resolve;
        });

        if (result.done) break;
        yield result.value;
      }

      await sendTask;
    },

    async close(): Promise<void> {
      if (ws && ws.readyState === WebSocket.OPEN) {
        _state = 'closing';
        ws.close();
      }
      _state = 'closed';
    },
  };

  return session;
}
