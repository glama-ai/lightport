/**
 * Adapter utilities for Messages and Responses API.
 *
 * When a provider doesn't natively support the requested API (Messages or Responses),
 * these functions handle the request/response transformation via ChatCompletions
 * as an intermediate format. The decision is made per-provider inside tryPost,
 * so mixed configs (e.g., Anthropic + OpenAI in a loadbalancer) correctly use
 * native passthrough for native providers and the adapter for non-native ones.
 */

import { EventSourceParserStream } from 'eventsource-parser/stream';

import { openAiErrorEvent, openAiErrorResponse } from '../errors/openAiError';
import {
  transformMessagesToChatCompletions,
  transformChatCompletionsToMessages,
  transformStreamChunk as messagesTransformStreamChunk,
  createStreamState as messagesCreateStreamState,
  supportsMessagesApiNatively,
} from '../adapters/messages';
import {
  transformResponsesToChatCompletions,
  transformChatCompletionsToResponses,
  transformStreamChunk as responsesTransformStreamChunk,
  createStreamState as responsesCreateStreamState,
  supportsResponsesApiNatively,
  findUnsupportedResponsesFields,
} from '../adapters/responses';
import { logger } from '../logger';
import { endpointStrings } from '../providers/types';
import type { GatewayContext } from '../types/GatewayContext';
import { Params } from '../types/requestBody';
import { pipeToWriter } from './streamHandler';
import { TRUNCATION_NOTICE, setTruncationNotice } from './truncationNotice';

/**
 * The truncation, in the shape the transforms read a failure in.
 *
 * `adaptStreamingResponse` re-frames what the parser hands it as
 * `event: <name>\ndata: <payload>`, with the terminating blank line already
 * consumed — so the notice is trimmed to match. Fed in like any upstream error,
 * it comes back out in the adapted API's own vocabulary.
 */
const TRUNCATION_FRAME = openAiErrorEvent(TRUNCATION_NOTICE).trim();

// ── Types ───────────────────────────────────────────────────────────────────

export interface AdapterContext {
  /** Whether the adapter is active for this request */
  isActive: boolean;
  /** The original endpoint before switching to chatComplete */
  originalFn: endpointStrings;
  /** Raw request body (without overrides) for Responses API response echoing */
  originalRequest: any;
  /** The resolved provider name */
  provider: string;
}

export interface AdapterRequestResult {
  adapterCtx: AdapterContext;
  params: Params;
  requestBody: Params | FormData | ArrayBuffer | ReadableStream;
  fn: endpointStrings;
}

// ── Request Transform ───────────────────────────────────────────────────────

/**
 * Detect if an adapter is needed and transform the request accordingly.
 *
 * @returns `null` if no adapter is needed (native provider or non-adapter endpoint).
 * @returns A `Response` if the request should be rejected (e.g., GET/DELETE on non-native).
 * @returns An `AdapterRequestResult` with the transformed params, fn, and adapter context.
 */
export function applyAdapterRequestTransform(
  fn: endpointStrings,
  provider: string,
  params: Params,
  requestBody: Params | FormData | ArrayBuffer | ReadableStream,
  isStreamingMode: boolean,
  method: string,
): AdapterRequestResult | Response | null {
  if (fn === 'messages' && provider && !supportsMessagesApiNatively(provider, params.model || '')) {
    const originalRequest =
      requestBody instanceof ReadableStream || requestBody instanceof FormData
        ? {}
        : { ...(requestBody as Params) };
    const transformedParams = transformMessagesToChatCompletions(params);

    return {
      adapterCtx: {
        isActive: true,
        originalFn: fn,
        originalRequest,
        provider,
      },
      params: transformedParams,
      requestBody: transformedParams as any,
      fn: 'chatComplete',
    };
  }

  if (fn === 'createModelResponse' && provider && !supportsResponsesApiNatively(provider)) {
    const { refused, ignored } = findUnsupportedResponsesFields(params as Record<string, any>);

    // This provider is served by translating the request into a chat completion,
    // which keeps nothing between turns and leaves nothing to fetch afterwards.
    // A request built on that is refused rather than answered as though it had
    // been honoured — a conversation continued from a response that was never
    // stored comes back with no memory of it, and a 200 saying all was well.
    if (refused.length) {
      const plural = refused.length > 1;

      return openAiErrorResponse(
        {
          message:
            `${refused.join(', ')} ${plural ? 'are' : 'is'} only supported for providers that ` +
            `serve the Responses API themselves, and ${provider} is served by translating the ` +
            `request into a chat completion. Drop ${plural ? 'them' : 'it'}, or send this to a ` +
            `provider that serves the Responses API natively.`,
          type: 'invalid_request_error',
          param: refused[0],
        },
        400,
      );
    }

    // The rest change how the answer is arrived at rather than what is asked
    // for, so the request is served — but nothing acts on them, and saying so is
    // the difference between a caller knowing that and assuming otherwise.
    if (ignored.length) {
      logger.warn(
        { ignored, provider },
        'responses request names behaviour the translation to chat completions cannot provide',
      );
    }

    const originalRequest =
      requestBody instanceof ReadableStream || requestBody instanceof FormData
        ? {}
        : { ...(requestBody as Params) };
    const transformedParams = transformResponsesToChatCompletions(params);

    return {
      adapterCtx: {
        isActive: true,
        originalFn: fn,
        originalRequest,
        provider,
      },
      params: transformedParams,
      requestBody: transformedParams as any,
      fn: 'chatComplete',
    };
  }

  if (
    ['getModelResponse', 'deleteModelResponse', 'listResponseInputItems'].includes(fn) &&
    provider &&
    !supportsResponsesApiNatively(provider)
  ) {
    return openAiErrorResponse(
      {
        message: `${method} /v1/responses is only supported for native Responses API providers`,
        type: 'invalid_request_error',
      },
      400,
    );
  }

  return null;
}

// ── Response Transform ──────────────────────────────────────────────────────

/**
 * If the adapter is active, transform the chatComplete-format response
 * back to the original API format (Messages or Responses).
 * For non-adapter requests this is a no-op passthrough.
 */
export async function adaptResponse(
  response: Response,
  adapterCtx: AdapterContext,
  c: GatewayContext,
): Promise<Response> {
  if (!adapterCtx.isActive) return response;

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    return adaptStreamingResponse(response, adapterCtx.originalFn, c);
  }

  return adaptNonStreamingResponse(response, adapterCtx, c);
}

/**
 * Transform a non-streaming chatComplete JSON response to
 * Messages or Responses API format.
 */
async function adaptNonStreamingResponse(
  response: Response,
  adapterCtx: AdapterContext,
  c: GatewayContext,
): Promise<Response> {
  let json: any;
  try {
    json = await response.json();
  } catch (err) {
    logger.error(
      {
        err,
        originalFn: adapterCtx.originalFn,
        provider: adapterCtx.provider,
        status: response.status,
      },
      'Adapter response JSON parse failed, returning original response',
    );
    return openAiErrorResponse({ message: 'Internal error', type: 'server_error' }, 500);
  }

  let transformedJson: any;
  if (adapterCtx.originalFn === 'messages') {
    transformedJson = transformChatCompletionsToMessages(
      json,
      response.status,
      adapterCtx.provider,
    );
  } else {
    transformedJson = transformChatCompletionsToResponses(
      json,
      response.status,
      adapterCtx.provider,
      adapterCtx.originalRequest,
    );
  }

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');

  const newResponse = new Response(JSON.stringify(transformedJson), {
    status: response.status,
    headers,
  });

  // Update requestOptions so logging captures the adapted format
  const reqOptions = c.get('requestOptions');
  if (reqOptions?.length) {
    const lastOption = reqOptions[reqOptions.length - 1];
    lastOption.response = newResponse;
    lastOption.providerOptions.rubeusURL = adapterCtx.originalFn;
  }

  return newResponse;
}

// ── Streaming Transform ─────────────────────────────────────────────────────

/**
 * Transform a streaming chatComplete response to Messages or Responses API SSE format.
 * Reads from a clone of the response so the original body (stored in requestOptions)
 * remains readable for middleware/logging until the async overwrite completes.
 */
function adaptStreamingResponse(
  response: Response,
  originalFn: endpointStrings,
  c: GatewayContext,
): Response {
  if (!response.body) return response;

  const responseToProcess = response.clone();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = responseToProcess.body!.getReader();
  const encoder = new TextEncoder();

  // How this stream reports being cut short, should it be. The failure is fed
  // through the same transform an upstream error takes, so a truncation reads
  // exactly as any other failure does — sequenced with the events already sent,
  // naming the response it ends, and closing the lifecycle the caller has been
  // following. Only the state captured here can say any of that.
  let buildTruncationNotice: () => string | undefined;

  // Everything written to the socket on this path is a whole frame, and writes
  // keep their order, so the notice cannot land on a half-finished `data:` line
  // and merge into it. The separator costs nothing either way — an empty SSE
  // block dispatches no event — and it means the guarantee is held by the bytes
  // rather than by that argument remaining true.
  const separated = (frame: string | undefined) => (frame ? `\n\n${frame}` : undefined);

  if (originalFn === 'messages') {
    const state = messagesCreateStreamState();

    buildTruncationNotice = () => separated(messagesTransformStreamChunk(TRUNCATION_FRAME, state));

    // Closing the writer from a `finally` ended a failed stream exactly as it
    // ended a finished one: the readable side stops normally, sendWebResponse
    // sees no error and writes the terminating chunk, and an adapted caller is
    // handed a well-formed response for a completion that stopped halfway.
    // Aborting is what carries the failure to the one place still able to say
    // so. The completion flush stays where it was, inside the success path.
    pipeToWriter(
      async () => {
        for await (const chunk of readSSEStream(reader)) {
          const transformed = messagesTransformStreamChunk(chunk, state);
          if (transformed) {
            await writer.write(encoder.encode(transformed));
          }
        }

        // Flush completion events for providers whose streams end without
        // a `data: [DONE]` message (e.g. Google/Gemini).
        const finalEvents = messagesTransformStreamChunk('data: [DONE]', state);
        if (finalEvents) {
          await writer.write(encoder.encode(finalEvents));
        }
      },
      writer,
      'adapter stream transform error',
    );
  } else {
    // Responses API adapter
    const state = responsesCreateStreamState();

    buildTruncationNotice = () => separated(responsesTransformStreamChunk(TRUNCATION_FRAME, state));

    pipeToWriter(
      async () => {
        for await (const chunk of readSSEStream(reader)) {
          const transformed = responsesTransformStreamChunk(chunk, state);
          if (transformed) {
            await writer.write(encoder.encode(transformed));
          }
        }

        // Flush completion events for providers whose streams end without
        // a `data: [DONE]` message (e.g. Google/Gemini). The idempotency
        // guard in transformStreamChunk ensures this is a no-op when
        // [DONE] was already processed.
        const finalEvents = responsesTransformStreamChunk('data: [DONE]', state);
        if (finalEvents) {
          await writer.write(encoder.encode(finalEvents));
        }
      },
      writer,
      'adapter stream transform error',
    );
  }

  // Carry forward upstream headers (trace-id, cache-status, provider, etc.)
  // but override entity/transport headers for the new SSE body.
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');

  const adaptedResponse = new Response(readable, {
    status: 200,
    headers,
  });

  // Left for the send layer, which is where a truncation is noticed and where
  // nothing is known about the vocabulary these bytes are written in.
  setTruncationNotice(adaptedResponse, buildTruncationNotice);

  // Synchronously update requestOptions so the logging middleware
  // reads the adapted stream (not the pre-adapter Chat Completions stream).
  // Clone ensures both the client and the middleware can read independently.
  const requestOptions = c.get('requestOptions');
  if (requestOptions?.length) {
    const lastOption = requestOptions[requestOptions.length - 1];
    lastOption.response = adaptedResponse.clone();
    lastOption.providerOptions.rubeusURL = originalFn;
  }

  return adaptedResponse;
}

// ── SSE Stream Reader ───────────────────────────────────────────────────────

async function* readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const rawStream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
  });

  const eventStream = rawStream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());

  const eventReader = eventStream.getReader();

  while (true) {
    const { done, value: event } = await eventReader.read();
    if (done) break;

    yield event.event ? `event: ${event.event}\ndata: ${event.data}` : `data: ${event.data}`;
  }
}
