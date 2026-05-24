/**
 * AudioWorklet Ring Buffer Processor
 * 
 * Receives PCM Float32 samples via MessagePort from the main thread.
 * Maintains a circular buffer and outputs continuous audio.
 * Supports instant clear for barge-in.
 */
class RingBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer: 2 seconds at 48kHz (default AudioContext sample rate)
    this.bufferSize = 48000 * 2;
    this.buffer = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.readPos = 0;
    this.samplesAvailable = 0;
    this.underruns = 0;
    this.totalSamplesPlayed = 0;
    this.totalSamplesReceived = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === "samples") {
        this._writeSamples(event.data.samples);
      } else if (event.data.type === "clear") {
        this._clear();
      } else if (event.data.type === "get_metrics") {
        this.port.postMessage({
          type: "metrics",
          samplesAvailable: this.samplesAvailable,
          totalSamplesPlayed: this.totalSamplesPlayed,
          totalSamplesReceived: this.totalSamplesReceived,
          underruns: this.underruns,
          bufferUtilization: this.samplesAvailable / this.bufferSize,
        });
      }
    };
  }

  _writeSamples(samples) {
    const len = samples.length;
    this.totalSamplesReceived += len;

    for (let i = 0; i < len; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.bufferSize;

      if (this.samplesAvailable < this.bufferSize) {
        this.samplesAvailable++;
      } else {
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
    }
  }

  _clear() {
    this.writePos = 0;
    this.readPos = 0;
    this.samplesAvailable = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    const len = channel.length;

    if (this.samplesAvailable >= len) {
      for (let i = 0; i < len; i++) {
        channel[i] = this.buffer[this.readPos];
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
      this.samplesAvailable -= len;
      this.totalSamplesPlayed += len;
    } else if (this.samplesAvailable > 0) {
      const available = this.samplesAvailable;
      for (let i = 0; i < available; i++) {
        channel[i] = this.buffer[this.readPos];
        this.readPos = (this.readPos + 1) % this.bufferSize;
      }
      for (let i = available; i < len; i++) {
        channel[i] = 0;
      }
      this.totalSamplesPlayed += available;
      this.samplesAvailable = 0;
      this.underruns++;
    } else {
      for (let i = 0; i < len; i++) {
        channel[i] = 0;
      }
      if (this.totalSamplesReceived > 0) {
        this.underruns++;
      }
    }

    return true;
  }
}

registerProcessor("ring-buffer-processor", RingBufferProcessor);
