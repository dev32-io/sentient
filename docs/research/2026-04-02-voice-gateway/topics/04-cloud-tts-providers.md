# Cloud TTS Providers

## Original Scope
- Fish Audio: pricing, FishAudio-S1 quality, sub-500ms latency, 50+ emotion tags, streaming API, voice cloning
- Cartesia: ~40ms TTFA, Sonic model, cheaper than ElevenLabs, streaming support
- ElevenLabs: Flash v2.5 (75ms), premium quality, emotion range, API maturity
- PlayHT: 600+ voices, 140+ languages, pricing, PlayHT 3.0 model
- Deepgram Aura, MiniMax, Azure, Google Cloud TTS as secondary
- Head-to-head comparison table
- API design differences — how each provider handles streaming

## Expanded Sub-Topics
- **Streaming API mechanics**: WebSocket vs HTTP chunked vs SSE per provider — connection setup time, chunk format
- **Voice cloning depth**: Amount of reference audio needed, quality vs sample length, fine-tuning options
- **Emotion/style control granularity**: Which providers offer fine-grained control vs preset styles
- **Output audio formats**: Which codecs each provider supports natively, implications for downstream delivery
- **Concurrency limits**: How many simultaneous streams per API key, and how this affects multi-user gateways
- **SLA and uptime history**: Provider reliability track records
- **SSML support depth**: Which SSML tags each provider actually supports
- **Latency under load**: How TTFA degrades as request volume increases
- **New entrants**: Hume AI (emotionally expressive), LMNT, Resemble AI cloud offering

## Adjacent Areas
- Cost modeling for production workloads: typical voice app usage patterns and projected monthly costs
- Audio quality metrics: MOS scores, PESQ, objective quality measurement
- Vendor lock-in risks: proprietary voice IDs, migration difficulty

## Research Questions
1. Which cloud TTS provider offers the best latency-to-quality ratio for real-time voice applications?
2. How do streaming APIs differ across providers in terms of connection setup, chunk delivery, and error handling?
3. What are realistic per-user monthly costs at 100, 1K, and 10K daily active users for each provider?
4. Which providers support emotional/style control that can be driven programmatically from LLM context?
5. How portable are custom/cloned voices across providers — what's the migration story?
