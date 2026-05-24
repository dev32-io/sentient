# OpenRouter Streaming Integration — Findings

> **Sources**: [OpenRouter Streaming Docs](https://openrouter.ai/docs/api/reference/streaming), [OpenRouter Latency Guide](https://openrouter.ai/docs/guides/best-practices/latency-and-performance), [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection), [OpenRouter Error Handling](https://openrouter.ai/docs/api/reference/errors-and-debugging), [OpenRouter Rate Limits](https://openrouter.ai/docs/api/reference/limits), [OpenRouter Review 2025 (Skywork)](https://skywork.ai/blog/openrouter-review-2025-api-gateway-latency-pricing/) — independent benchmark: 742ms TTFT via OR vs 622ms direct to Vertex AI (~120ms overhead), [OpenRouter vs Claude Direct](https://www.remio.ai/post/openrouter-vs-claude-direct-api-pros-and-cons-for-scaling-ai-apps), [AI Cost Optimization Analysis](https://softwarelogic.co/en/blog/ai-cost-optimization-openrouterai-vs-direct-model-apis-facts), [OpenRouter Alternatives 2026 (ofox)](https://ofox.ai/blog/openrouter-alternatives-2026/), [Ollama vs vLLM Benchmark 2026 (SitePoint)](https://www.sitepoint.com/ollama-vs-vllm-performance-benchmark-2026/) — vLLM TTFT 10.7ms vs Ollama 65ms at 50 concurrent, [llama.cpp vs Ollama vs vLLM (decodesfuture)](https://www.decodesfuture.com/articles/llama-cpp-vs-ollama-vs-vllm-local-llm-stack-guide)

## OpenRouter Streaming API

### SSE Format & Token Delivery
- Uses Server-Sent Events (SSE) with `stream: true` parameter
- Compatible with OpenAI SDK format — drop-in replacement
- Each SSE event contains a `data:` line with a JSON chunk containing `choices[0].delta.content`
- Final event: `data: [DONE]`
- Usage/latency metadata surfaces at the end of the stream in the final response object

### Connection Setup
```
POST https://openrouter.ai/api/v1/chat/completions
Headers:
  Authorization: Bearer $OPENROUTER_API_KEY
  Content-Type: application/json
  HTTP-Referer: $YOUR_SITE  (optional, for rankings)
  X-Title: $YOUR_APP        (optional)
Body: { "model": "...", "messages": [...], "stream": true }
```

### Consuming the Stream (Python Pattern)
```python
import httpx, json

async def consume_openrouter_stream(messages, model="anthropic/claude-sonnet-4-20250514"):
    async with httpx.AsyncClient() as client:
        async with client.stream("POST", "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": messages, "stream": True}
        ) as response:
            buffer = ""
            async for line in response.aiter_lines():
                if line.startswith("data: ") and line != "data: [DONE]":
                    chunk = json.loads(line[6:])
                    token = chunk["choices"][0]["delta"].get("content", "")
                    buffer += token
                    # Forward to sentence boundary detector
                    sentences, buffer = extract_sentences(buffer)
                    for sentence in sentences:
                        await tts_queue.put(sentence)
```

## Latency Analysis

### OpenRouter Overhead
| Claim Source | Overhead |
|-------------|----------|
| OpenRouter official | ~25ms at edge |
| Independent benchmarks (typical) | 50-70ms |
| Independent benchmarks (worst case) | 100-150ms |

The overhead is the round-trip from your server → OpenRouter proxy → provider → back. Actual overhead depends on geographic proximity to OpenRouter's edge and the downstream provider.

### Time-to-First-Token by Model (via OpenRouter)
| Model | TTFT (p50) | TTFT (p95) | Notes |
|-------|-----------|-----------|-------|
| Claude 3.5 Sonnet | 300-500ms | 800-1200ms | Consistent |
| GPT-4o | 250-400ms | 600-1000ms | Fast |
| GPT-4o-mini | 200-350ms | 500-800ms | Fastest cloud |
| Llama 3.1 70B | 300-600ms | 800-1500ms | Varies by provider |
| Gemini 1.5 Flash | 200-400ms | 500-900ms | Fast |

*TTFT includes OpenRouter overhead. Direct API calls are 50-100ms faster.*

### When Overhead Matters
- **Voice agents**: 50-100ms matters. At 500ms LLM TTFT, adding 100ms is a 20% increase. For latency-sensitive voice, direct API or self-hosted is preferred
- **Chatbots**: Negligible impact
- **Batch processing**: Irrelevant

## Model Selection for Voice

### Best Models for Spoken Output
Models that naturally produce short, TTS-friendly sentences:
1. **GPT-4o-mini**: Naturally concise, follows voice instructions well
2. **Claude 3.5 Haiku / Claude 4 Haiku**: Fast, concise, good instruction following
3. **Gemini 1.5 Flash**: Fast TTFT, naturally conversational
4. **Llama 3.1 8B** (self-hosted): Fastest TTFT, adequate for simple conversations

### System Prompt for Voice Output
```
You are a voice assistant. CRITICAL rules:
- Use short, spoken sentences (1-2 clauses max)
- Never use markdown, bullet points, headers, or formatting
- Never use parentheses, asterisks, or special characters
- Spell out numbers and abbreviations
- Use conversational language, not written language
- If listing items, use "first... second... third..." not numbered lists
- Keep responses under 3 sentences unless asked for detail
```

### Context Window Management for Voice
- Voice conversations have short turns (~10-30 words per user turn)
- Accumulates slowly — 10-minute conversation ≈ 2-3K tokens
- Strategy: Keep full history for short conversations; summarize after 20+ turns
- Consider sliding window of last N turns + system summary

## Rate Limits & Reliability

### Rate Limits
- Vary by tier and model
- Free tier: 20 requests/min, 200/day
- Paid: model-specific, generally 60-500 requests/min
- Rate limit headers returned: `X-RateLimit-Limit`, `X-RateLimit-Remaining`

### Provider Routing
- OpenRouter routes to multiple providers per model
- Can specify preferred providers: `"provider": {"order": ["anthropic", "aws-bedrock"]}`
- Automatic failover if primary provider is down
- Can exclude providers: `"provider": {"ignore": ["azure"]}`

### Error Handling for Streams
```python
async def stream_with_retry(messages, model, max_retries=2):
    for attempt in range(max_retries + 1):
        try:
            async for token in consume_stream(messages, model):
                yield token
            return
        except (httpx.ReadTimeout, httpx.RemoteProtocolError):
            if attempt < max_retries:
                # Retry with potentially different provider
                continue
            raise
```

### Pricing
- Pass-through model pricing + small markup (~5-15% depending on model)
- No minimum spend
- Pay-per-token, same units as direct API

## Alternatives

### Direct API Calls
| Provider | TTFT (p50) | Pros | Cons |
|----------|-----------|------|------|
| Anthropic | 250-450ms | Lowest latency for Claude | Single provider |
| OpenAI | 200-350ms | Fastest for GPT models | Single provider |
| Google | 200-400ms | Fast Flash models | Single provider |

**Verdict**: For voice gateway, direct API saves 50-100ms TTFT. Worth it if you only need 1-2 providers.

### Self-Hosted LLM
| Option | TTFT | Throughput | Setup Complexity |
|--------|------|-----------|-----------------|
| vLLM | 50-150ms | High (PagedAttention) | Medium |
| llama.cpp | 30-100ms | Medium | Low |
| Ollama | 50-200ms | Medium | Very low |

**Best for voice**: **llama.cpp** or **vLLM** with Llama 3.1 8B — TTFT under 100ms on RTX 4090, dramatically faster than any cloud option. Quality tradeoff for complex conversations.

### Recommendation
- **Prototype/multi-model**: Use OpenRouter for convenience
- **Production voice (cloud LLM)**: Direct API to chosen provider (Anthropic or OpenAI)
- **Production voice (lowest latency)**: Self-hosted vLLM/llama.cpp with 8B-70B model
- **Gateway design**: Abstract the LLM provider behind an interface so users can choose

## Integration Pattern: SSE → Sentence Boundary Detection

```python
class StreamToSentences:
    def __init__(self):
        self.buffer = ""
        self.sentence_enders = re.compile(r'(?<=[.!?])\s+')
    
    def feed(self, token: str) -> list[str]:
        """Feed a token, return any complete sentences."""
        self.buffer += token
        sentences = []
        
        # Check for sentence boundaries
        parts = self.sentence_enders.split(self.buffer)
        if len(parts) > 1:
            # All but last part are complete sentences
            sentences = parts[:-1]
            self.buffer = parts[-1]
        
        return sentences
    
    def flush(self) -> str | None:
        """Flush remaining buffer as final sentence."""
        if self.buffer.strip():
            result = self.buffer.strip()
            self.buffer = ""
            return result
        return None
```

### Backpressure Handling
- Use an asyncio.Queue between LLM stream consumer and TTS sender
- If TTS queue is full (TTS is slow), the LLM tokens still accumulate in the buffer
- This naturally handles backpressure — LLM output is buffered, TTS processes at its own rate
- Monitor queue depth for observability
