/**
 * Raw WebSocket client for Deepgram Nova-3 streaming STT.
 * No SDK dependency — implements the protocol directly.
 * Designed for Bun runtime.
 */

export interface DeepgramConfig {
  apiKey: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  encoding?: string;
  endpointing?: number;
  utteranceEndMs?: number;
  interimResults?: boolean;
  vadEvents?: boolean;
  smartFormat?: boolean;
  punctuate?: boolean;
}

export interface TranscriptResult {
  type: 'interim' | 'final' | 'speech_final' | 'utterance_end';
  transcript: string;
  confidence: number;
  isFinal: boolean;
  speechFinal: boolean;
  start: number;
  duration: number;
  words?: Array<{ word: string; start: number; end: number; confidence: number }>;
}

export type DeepgramEvent =
  | { type: 'transcript'; data: TranscriptResult }
  | { type: 'speech_started' }
  | { type: 'utterance_end' }
  | { type: 'error'; error: Error }
  | { type: 'open' }
  | { type: 'close'; code: number; reason: string };

type EventHandler = (event: DeepgramEvent) => void;

export class DeepgramStreamingClient {
  private ws: WebSocket | null = null;
  private config: Required<DeepgramConfig>;
  private handlers: EventHandler[] = [];
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private _isOpen = false;

  // Double-endpointing state
  private transcriptBuffer: string[] = [];
  private speechFinalReceived = false;
  private utteranceEndReceived = false;
  private flushCallback: ((text: string, trigger: string) => void) | null = null;

  constructor(config: DeepgramConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? 'nova-3',
      language: config.language ?? 'en-US',
      sampleRate: config.sampleRate ?? 16000,
      encoding: config.encoding ?? 'linear16',
      endpointing: config.endpointing ?? 300,
      utteranceEndMs: config.utteranceEndMs ?? 1000,
      interimResults: config.interimResults ?? true,
      vadEvents: config.vadEvents ?? true,
      smartFormat: config.smartFormat ?? true,
      punctuate: config.punctuate ?? true,
    };
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  onFlush(cb: (text: string, trigger: string) => void): void {
    this.flushCallback = cb;
  }

  on(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private emit(event: DeepgramEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      model: this.config.model,
      language: this.config.language,
      sample_rate: String(this.config.sampleRate),
      encoding: this.config.encoding,
      endpointing: String(this.config.endpointing),
      utterance_end_ms: String(this.config.utteranceEndMs),
      interim_results: String(this.config.interimResults),
      vad_events: String(this.config.vadEvents),
      smart_format: String(this.config.smartFormat),
      punctuate: String(this.config.punctuate),
    });
    return "wss://api.deepgram.com/v1/listen?" + params.toString();
  }

  connect(url?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = url ?? this.buildUrl();

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: "Token " + this.config.apiKey,
        },
      } as any);

      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this._isOpen = true;
        this.startKeepAlive();
        this.emit({ type: 'open' });
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onerror = (_event: Event) => {
        const err = new Error('WebSocket error');
        this.emit({ type: 'error', error: err });
        reject(err);
      };

      this.ws.onclose = (event: CloseEvent) => {
        this._isOpen = false;
        this.stopKeepAlive();
        this.emit({ type: 'close', code: event.code, reason: event.reason });
      };
    });
  }

  sendAudio(data: ArrayBuffer | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(data);
  }

  private sendKeepAlive(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }

  close(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    this.stopKeepAlive();
  }

  forceClose(): void {
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._isOpen = false;
  }

  private startKeepAlive(): void {
    this.keepAliveInterval = setInterval(() => this.sendKeepAlive(), 8000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'Results') {
      this.handleTranscriptResult(msg);
    } else if (msg.type === 'SpeechStarted') {
      this.emit({ type: 'speech_started' });
    } else if (msg.type === 'UtteranceEnd') {
      this.handleUtteranceEnd();
    }
  }

  private handleTranscriptResult(msg: any): void {
    const alt = msg.channel?.alternatives?.[0];
    if (!alt) return;

    const isFinal = msg.is_final === true;
    const speechFinal = msg.speech_final === true;

    const result: TranscriptResult = {
      type: speechFinal ? 'speech_final' : isFinal ? 'final' : 'interim',
      transcript: alt.transcript ?? '',
      confidence: alt.confidence ?? 0,
      isFinal,
      speechFinal,
      start: msg.start ?? 0,
      duration: msg.duration ?? 0,
      words: alt.words,
    };

    this.emit({ type: 'transcript', data: result });

    // Double-endpointing: accumulate is_final segments
    if (isFinal && alt.transcript) {
      this.transcriptBuffer.push(alt.transcript);
    }

    // speech_final triggers first-wins flush
    if (speechFinal && !this.speechFinalReceived) {
      this.speechFinalReceived = true;
      this.tryFlush('speech_final');
    }
  }

  private handleUtteranceEnd(): void {
    this.emit({ type: 'utterance_end' });

    if (!this.utteranceEndReceived) {
      this.utteranceEndReceived = true;
      this.tryFlush('utterance_end');
    }
  }

  /** First-wins flush: whichever signal arrives first triggers the flush */
  private tryFlush(trigger: string): void {
    // If buffer empty, reset flags so next utterance works
    if (this.transcriptBuffer.length === 0) {
      this.speechFinalReceived = false;
      this.utteranceEndReceived = false;
      return;
    }

    const text = this.transcriptBuffer.join(' ').trim();
    if (text && this.flushCallback) {
      this.flushCallback(text, trigger);
    }

    // Reset for next utterance
    this.transcriptBuffer = [];
    this.speechFinalReceived = false;
    this.utteranceEndReceived = false;
  }

  resetBuffer(): void {
    this.transcriptBuffer = [];
    this.speechFinalReceived = false;
    this.utteranceEndReceived = false;
  }
}
