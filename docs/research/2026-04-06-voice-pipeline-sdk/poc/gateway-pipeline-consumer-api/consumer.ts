// consumer.ts — What a developer actually writes. <50 lines. Zero internal knowledge.
//
// This is the ENTIRE integration code a gateway developer needs.
// They don't know about stages, sentence aggregation, streaming overlap,
// frame types, or provider lifecycles.

import { createVoicePipeline, type PipelineEvent } from "./pipeline-sdk";
import { createMockSTT, createMockLLM, createMockTTS } from "./mock-providers";

// 1. Create pipeline — plug in providers, done.
const pipeline = createVoicePipeline({
  stt: createMockSTT(),
  llm: createMockLLM(),
  tts: createMockTTS(),
  systemPrompt: "You are a helpful voice assistant.",
});

// 2. Subscribe to events — single handler for everything.
pipeline.on((event: PipelineEvent) => {
  switch (event.type) {
    case "state.changed":
      console.log(`[${event.to}]`);
      break;
    case "transcript.partial":
      console.log(`  hearing: "${event.text}"`);
      break;
    case "transcript.final":
      console.log(`  heard: "${event.text}"`);
      break;
    case "response.text.delta":
      process.stdout.write(event.text);
      break;
    case "response.text.done":
      console.log(); // newline after streamed text
      break;
    case "response.audio.frame":
      // In real code: send to AudioWorklet or WebSocket
      break;
    case "response.audio.done":
      console.log("  (audio complete)");
      break;
    case "error":
      console.error(`  error: ${event.message}`);
      break;
  }
});

// 3. Start and simulate a voice turn.
async function main() {
  await pipeline.start();

  // Simulate: user speaks
  pipeline.utteranceStart();
  pipeline.sendAudio(new Uint8Array(320)); // mic audio chunk
  pipeline.sendAudio(new Uint8Array(320));
  pipeline.utteranceEnd(); // VAD detected end-of-speech

  // Wait for pipeline to process
  await new Promise((r) => setTimeout(r, 500));
  await pipeline.destroy();
}

main();
