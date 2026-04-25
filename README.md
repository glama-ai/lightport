# Lightport

A lightweight AI gateway that routes requests to 250+ LLMs.

## What it does

Lightport accepts OpenAI-compatible requests, transforms them for the target provider, and returns the response. No retries, no fallbacks, no caching, no auth layer – just a thin proxy with provider adapters.

**Supported endpoints:**

- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses` (+ GET, DELETE, input_items)

**Supported providers:** OpenAI, Anthropic, Azure OpenAI, Google Gemini, Vertex AI, Bedrock, Cohere, Mistral, Groq, Deepseek, Together AI, Fireworks, Ollama, and [80+ more](src/providers/).

## Background

Lightport started as a fork of [Portkey AI Gateway](https://github.com/portkey-ai/gateway). Our sole use case for the gateway has always been making AI providers OpenAI-compatible — we only needed the request/response transformation layer.

Since then, Portkey has evolved into a full-featured AI gateway with guardrails, fallbacks, automatic retries, load balancing, request timeouts, smart caching, usage analytics, cost management, and more. We believe those capabilities belong at a higher abstraction level — which is what [Glama](https://glama.ai/ai/gateway) provides — rather than in the gateway itself.

Since forking, we have fixed numerous bugs, added integration tests for every provider, and continue to actively maintain the gateway as it directly powers [Glama](https://glama.ai/ai/gateway).

If you need a lightweight proxy that makes 250+ AI providers OpenAI-compatible, Lightport is for you. If you need an enterprise gateway with all the bells and whistles, consider [Portkey Gateway](https://github.com/portkey-ai/gateway).

## Quickstart

```bash
pnpm install
pnpm dev
```

The gateway runs on `http://localhost:8787`.

### Make a request

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-lightport-provider: openai" \
  -H "Authorization: Bearer sk-YOUR-KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Set the provider via `x-lightport-provider` header and pass credentials via `Authorization` (or provider-specific headers like `x-api-key` for Anthropic).

### Provider-specific headers

Some providers require additional headers:

| Provider     | Headers                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| Azure OpenAI | `x-lightport-azure-resource-name`, `x-lightport-azure-deployment-id`, `x-lightport-azure-api-version` |
| Bedrock      | `x-lightport-aws-access-key-id`, `x-lightport-aws-secret-access-key`, `x-lightport-aws-region`        |
| Vertex AI    | `x-lightport-vertex-project-id`, `x-lightport-vertex-region`                                          |
| Custom host  | `x-lightport-custom-host`                                                                             |

## Scripts

```bash
pnpm dev           # Development server with hot reload
pnpm build         # Production build
pnpm start:node    # Start production server
pnpm test          # Run tests
pnpm lint          # Lint code
pnpm format        # Format and auto-fix
pnpm knip          # Find unused code/dependencies
```

### Testing with provider credentials

Copy `.env.example` to `.env` and fill in API keys for the providers you want to test. Tests automatically load `.env` and skip providers without credentials.

```bash
cp .env.example .env
# fill in your keys
pnpm test
```

## Architecture

```
Request
  -> bodyParser middleware (parse JSON/FormData)
  -> requestValidator (require provider header)
  -> handler (chatCompletions / completions / modelResponses)
    -> constructConfigFromRequestHeaders()
    -> tryPost()
      -> adapter transform (if needed for responses/messages API)
      -> provider lookup + transformToProviderRequest()
      -> fetch to provider
      -> responseHandler() (transform response back)
    -> Response
```

The provider system (`src/providers/`) contains 85+ provider implementations. Each defines:

- API config (base URL, endpoints, headers)
- Request parameter transforms
- Response transforms (streaming + non-streaming)

## License

MIT
