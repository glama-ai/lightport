# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lightport** is a lightweight AI gateway that routes requests to 250+ LLMs. A thin proxy with provider adapters, built with Fastify for Node.js.

## Development Commands

- `pnpm dev` - Start development server with hot reload
- `pnpm build` - Build the project for production
- `pnpm start:node` - Start production Node.js server
- `pnpm test` - Run tests (vitest, auto-loads `.env` via dotenv-cli)
- `pnpm knip` - Find unused code and dependencies
- `pnpm lint` - Lint code with oxlint
- `pnpm format` - Format with oxfmt and auto-fix lint issues

## Architecture

### Request Flow

```
Request → bodyParser → requestValidator → handler → tryPost() → provider → Response
```

### Core Components

**Entry Point (`src/index.ts`)**

- Fastify app with 6 routes: `/v1/chat/completions`, `/v1/completions`, `/v1/responses` (CRUD)
- Middleware: CORS, body parser, request validator

**Handlers (`src/handlers/`)**

- `chatCompletionsHandler.ts` - Chat completions
- `completionsHandler.ts` - Text completions
- `modelResponsesHandler.ts` - OpenAI Responses API
- `handlerUtils.ts` - Core `tryPost()` function that does: adapter transform → provider lookup → request transform → fetch → response transform
- `streamHandler.ts` - SSE and AWS stream handling
- `responseHandlers.ts` - Response format transformation

**Provider System (`src/providers/`)**

- 85+ provider implementations (OpenAI, Anthropic, Azure, Bedrock, etc.)
- Each provider defines: API config (headers, URLs), request transforms, response transforms
- Registered in `src/providers/index.ts`

**Adapters (`src/adapters/`)**

- Messages API adapter (Anthropic format → chatComplete)
- Responses API adapter (OpenAI responses → chatComplete)
- Applied when a provider doesn't natively support the requested API

**Middleware (`src/middlewares/`)**

- `lightport/index.ts` - Body parser (JSON/FormData/binary)
- `requestValidator/` - Validates `x-lightport-provider` header and content type

### Key Utilities

- `src/utils/request.ts` - `constructConfigFromRequestHeaders()` builds provider Options from request headers
- `src/services/transformToProviderRequest.ts` - Transforms gateway request params to provider format
- `src/utils/fetch.ts` - HTTP fetch with proxy/TLS agent support
- `src/services/cache/cacheService.ts` - Simple in-memory cache for provider credential caching (Azure Entra, AWS STS tokens)

## Testing

Tests use vitest. Test files are colocated in `__tests__/` directories.

```bash
pnpm test             # Run all tests
```
