# LLM Service (`services/llm`)

| Export | API | Notes |
|:-------|:----|:------|
| `ILlmProvider` | `.chatCompletion(params, context) -> Promise<ChatCompletion \| Stream<ChatCompletionChunk>>` `.chatCompletionStream(params, context) -> Promise<AsyncIterable<ChatCompletionChunk>>` | OpenAI-compatible interface. `params.stream` discriminates return type on `chatCompletion`. Context is `RequestContext`, not unified `Context`. |
| `OpenRouterProvider` | Implements `ILlmProvider` via OpenRouter API | Tier 3 peer: `openai`. Lazy-loaded. Rate-limited via `RateLimiter`. SDK-level retries (`maxRetries: 2`) with exponential backoff on 429/5xx. |
| `OpenRouterChatParams` | `ChatCompletionCreateParamsNonStreaming \| ChatCompletionCreateParamsStreaming` | OpenAI SDK types — OpenRouter is API-compatible. |

## Configuration

| Env Var | Purpose |
|:--------|:--------|
| `OPENROUTER_API_KEY` | API key (required to enable LLM service) |
| `OPENROUTER_APP_URL` | App URL for OpenRouter rankings |
| `OPENROUTER_APP_NAME` | App name for OpenRouter rankings |
| `LLM_DEFAULT_MODEL` | Default model ID (e.g., `anthropic/claude-sonnet-4-20250514`) |
| `LLM_DEFAULT_MAX_TOKENS` | Default max tokens |
| `LLM_DEFAULT_TEMPERATURE` | Default temperature |

## Usage

```ts
// In a tool handler — assumes LLM provider was initialized in setup()
// Note: chatCompletion takes RequestContext, not the unified Context.
// In services, pass the RequestContext directly. In tool handlers,
// create one via requestContextService or pass through from the service layer.
const completion = await llmProvider.chatCompletion({
  model: 'anthropic/claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 500,
}, requestContext);
```

Streaming variant:

```ts
const stream = await llmProvider.chatCompletionStream({
  model: 'anthropic/claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 500,
}, requestContext);

for await (const chunk of stream) {
  // chunk is ChatCompletionChunk
}
```
