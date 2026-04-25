import { EventSourceParserStream } from 'eventsource-parser/stream';

import {
  AZURE_OPEN_AI,
  BEDROCK,
  CONTENT_TYPES,
  COHERE,
  GOOGLE,
  REQUEST_TIMEOUT_STATUS_CODE,
  PRECONDITION_CHECK_FAILED_STATUS_CODE,
  GOOGLE_VERTEX_AI,
} from '../globals';
import { logger } from '../logger';
import { VertexLlamaChatCompleteStreamChunkTransform } from '../providers/google-vertex-ai/chatComplete';
import { OpenAIChatCompleteResponse } from '../providers/openai/chatComplete';
import { OpenAICompleteResponse } from '../providers/openai/complete';
import { endpointStrings } from '../providers/types';
import { captureException } from '../sentry/captureException';
import type { GatewayContext } from '../types/GatewayContext';
import { Params } from '../types/requestBody';
import { getStreamModeSplitPattern, type SplitPatternType } from '../utils';
import { parseJson } from '../utils/parseJson';

function pipeToWriter(
  fn: () => Promise<void>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): void {
  fn()
    .catch((err) => {
      // Client disconnects reject with undefined
      if (err !== undefined) {
        logger.error({ err }, 'stream transform error');
        captureException({ error: err, message: 'stream transform error' });
      }
    })
    .finally(async () => {
      try {
        if (writer.desiredSize !== null) await writer.close();
      } catch {
        // Writer may already be closed if the readable side was cancelled
      }
    });
}

function readUInt32BE(buffer: Uint8Array, offset: number) {
  return (
    ((buffer[offset] << 24) |
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3]) >>>
    0
  );
}

function getPayloadFromAWSChunk(chunk: Uint8Array): string {
  const decoder = new TextDecoder();
  const chunkLength = readUInt32BE(chunk, 0);
  const headersLength = readUInt32BE(chunk, 4);

  const headersEnd = 12 + headersLength;

  const payloadLength = chunkLength - headersEnd - 4;
  const payload = chunk.slice(headersEnd, headersEnd + payloadLength);
  const decodedJson = parseJson<Record<string, any>>(decoder.decode(payload));
  return decodedJson.bytes
    ? Buffer.from(decodedJson.bytes, 'base64').toString()
    : JSON.stringify(decodedJson);
}

function concatenateUint8Arrays(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

async function* readAWSStream(
  reader: ReadableStreamDefaultReader,
  transformFunction: Function | undefined,
  fallbackChunkId: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
) {
  let buffer = new Uint8Array();
  let expectedLength = 0;
  const streamState = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.length) {
        expectedLength = readUInt32BE(buffer, 0);
        while (buffer.length >= expectedLength && buffer.length !== 0) {
          const data = buffer.subarray(0, expectedLength);
          buffer = buffer.subarray(expectedLength);
          expectedLength = readUInt32BE(buffer, 0);
          const payload = getPayloadFromAWSChunk(data);
          if (transformFunction) {
            const transformedChunk = transformFunction(
              payload,
              fallbackChunkId,
              streamState,
              strictOpenAiCompliance,
              gatewayRequest,
            );
            if (Array.isArray(transformedChunk)) {
              for (const item of transformedChunk) {
                yield item;
              }
            } else {
              yield transformedChunk;
            }
          } else {
            yield data;
          }
        }
      }
      break;
    }

    if (expectedLength === 0) {
      expectedLength = readUInt32BE(value, 0);
    }

    buffer = concatenateUint8Arrays(buffer, value);

    while (buffer.length >= expectedLength && buffer.length !== 0) {
      const data = buffer.subarray(0, expectedLength);
      buffer = buffer.subarray(expectedLength);

      expectedLength = readUInt32BE(buffer, 0);
      const payload = getPayloadFromAWSChunk(data);

      if (transformFunction) {
        const transformedChunk = transformFunction(
          payload,
          fallbackChunkId,
          streamState,
          strictOpenAiCompliance,
          gatewayRequest,
        );
        if (Array.isArray(transformedChunk)) {
          for (const item of transformedChunk) {
            yield item;
          }
        } else {
          yield transformedChunk;
        }
      } else {
        yield data;
      }
    }
  }
}

async function* readSSEStream(
  reader: ReadableStreamDefaultReader,
  transformFunction: Function | undefined,
  isSleepTimeRequired: boolean,
  fallbackChunkId: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
) {
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
  let isFirstChunk = true;
  const streamState = {};

  while (true) {
    const { done, value: event } = await eventReader.read();
    if (done) break;

    const chunk = event.event
      ? `event: ${event.event}\ndata: ${event.data}`
      : `data: ${event.data}`;

    if (isFirstChunk) {
      isFirstChunk = false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } else if (isSleepTimeRequired) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    if (transformFunction) {
      const transformedChunk = transformFunction(
        chunk,
        fallbackChunkId,
        streamState,
        strictOpenAiCompliance,
        gatewayRequest,
      );
      if (transformedChunk !== undefined) {
        yield transformedChunk;
      }
    } else {
      yield `${chunk}\n\n`;
    }
  }
}

async function* readNDJSONStream(
  reader: ReadableStreamDefaultReader,
  splitPattern: SplitPatternType,
  transformFunction: Function | undefined,
  isSleepTimeRequired: boolean,
  fallbackChunkId: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
) {
  let buffer = '';
  const decoder = new TextDecoder();
  let isFirstChunk = true;
  const streamState = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.length > 0) {
        if (transformFunction) {
          yield transformFunction(
            buffer,
            fallbackChunkId,
            streamState,
            strictOpenAiCompliance,
            gatewayRequest,
          );
        } else {
          yield buffer;
        }
      }
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.split(splitPattern).length > 1) {
      const parts = buffer.split(splitPattern);
      const lastPart = parts.pop() ?? '';
      for (const part of parts) {
        if (part.length > 0) {
          if (isFirstChunk) {
            isFirstChunk = false;
            await new Promise((resolve) => setTimeout(resolve, 25));
          } else if (isSleepTimeRequired) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }

          if (transformFunction) {
            const transformedChunk = transformFunction(
              part,
              fallbackChunkId,
              streamState,
              strictOpenAiCompliance,
              gatewayRequest,
            );
            if (transformedChunk !== undefined) {
              yield transformedChunk;
            }
          } else {
            yield part + splitPattern;
          }
        }
      }

      buffer = lastPart;
    }
  }
}

async function* readStream(
  reader: ReadableStreamDefaultReader,
  splitPattern: SplitPatternType,
  transformFunction: Function | undefined,
  isSleepTimeRequired: boolean,
  fallbackChunkId: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
) {
  if (splitPattern === '\n\n' || splitPattern === '\r\n\r\n') {
    yield* readSSEStream(
      reader,
      transformFunction,
      isSleepTimeRequired,
      fallbackChunkId,
      strictOpenAiCompliance,
      gatewayRequest,
    );
  } else {
    yield* readNDJSONStream(
      reader,
      splitPattern,
      transformFunction,
      isSleepTimeRequired,
      fallbackChunkId,
      strictOpenAiCompliance,
      gatewayRequest,
    );
  }
}

export async function handleTextResponse(
  response: Response,
  responseTransformer: Function | undefined,
) {
  const text = await response.text();

  if (responseTransformer) {
    const transformedText = responseTransformer({ 'html-message': text }, response.status);
    return new Response(JSON.stringify(transformedText), {
      ...response,
      status: response.status,
      headers: new Headers({
        ...Object.fromEntries(response.headers),
        'content-type': 'application/json',
      }),
    });
  }

  return new Response(text, response);
}

const stripTransportHeaders = (response: Response): HeadersInit => {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return headers;
};

export async function handleNonStreamingMode(
  response: Response,
  responseTransformer: Function | undefined,
  strictOpenAiCompliance: boolean,
  gatewayRequestUrl: string,
  gatewayRequest: Params,
  areSyncHooksAvailable: boolean,
): Promise<{
  response: Response;
  json: Record<string, any> | null;
  originalResponseBodyJson?: Record<string, any> | null;
  timeToLastByte?: number | null;
}> {
  if (
    [REQUEST_TIMEOUT_STATUS_CODE, PRECONDITION_CHECK_FAILED_STATUS_CODE].includes(response.status)
  ) {
    return { response, json: await response.clone().json() };
  }

  const isJsonParsingRequired = responseTransformer || areSyncHooksAvailable;
  const originalResponseBodyJson: Record<string, any> | null = isJsonParsingRequired
    ? await response.json()
    : null;
  const timeToLastByte = Date.now();
  let responseBodyJson = originalResponseBodyJson;
  if (responseTransformer) {
    responseBodyJson = responseTransformer(
      responseBodyJson,
      response.status,
      response.headers,
      strictOpenAiCompliance,
      gatewayRequestUrl,
      gatewayRequest,
    );
  } else if (!areSyncHooksAvailable) {
    return {
      response: new Response(response.body, {
        status: response.status,
        headers: stripTransportHeaders(response),
      }),
      json: null,
      originalResponseBodyJson,
      timeToLastByte,
    };
  }

  return {
    response: new Response(JSON.stringify(responseBodyJson), {
      status: response.status,
      headers: stripTransportHeaders(response),
    }),
    json: responseBodyJson as Record<string, any>,
    ...(responseTransformer && { originalResponseBodyJson }),
    timeToLastByte,
  };
}

export function handleAudioResponse(response: Response) {
  return new Response(response.body, response);
}

export function handleOctetStreamResponse(response: Response) {
  return new Response(response.body, response);
}

export function handleImageResponse(response: Response) {
  return new Response(response.body, response);
}

export function handleStreamingMode(
  c: GatewayContext,
  response: Response,
  proxyProvider: string,
  responseTransformer: Function | undefined,
  requestURL: string,
  strictOpenAiCompliance: boolean,
  gatewayRequest: Params,
  _fn: endpointStrings,
  _hooksResult: any,
): Response {
  const splitPattern = getStreamModeSplitPattern(proxyProvider, requestURL);
  const fallbackChunkId = `${proxyProvider}-${Date.now().toString()}`;

  if (!response.body) {
    throw new Error('Response format is invalid. Body not found');
  }
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = response.body.getReader();
  const isSleepTimeRequired = proxyProvider === AZURE_OPEN_AI ? true : false;
  const encoder = new TextEncoder();

  if (proxyProvider === BEDROCK) {
    pipeToWriter(async () => {
      for await (const chunk of readAWSStream(
        reader,
        responseTransformer,
        fallbackChunkId,
        strictOpenAiCompliance,
        gatewayRequest,
      )) {
        await writer.write(encoder.encode(chunk));
      }
    }, writer);
  } else {
    pipeToWriter(async () => {
      for await (const chunk of readStream(
        reader,
        splitPattern,
        responseTransformer,
        isSleepTimeRequired,
        fallbackChunkId,
        strictOpenAiCompliance,
        gatewayRequest,
      )) {
        await writer.write(encoder.encode(chunk));
      }
    }, writer);
  }

  // The upstream body has been decompressed by the reader and re-encoded
  // through the transform pipeline, so content-encoding/content-length
  // from the upstream response no longer apply.
  const isGoogleCohereOrBedrock = [GOOGLE, COHERE, BEDROCK].includes(proxyProvider);
  const isVertexLlama =
    proxyProvider === GOOGLE_VERTEX_AI &&
    responseTransformer?.name === VertexLlamaChatCompleteStreamChunkTransform.name;
  const isJsonStream = isGoogleCohereOrBedrock || isVertexLlama;
  if (isJsonStream && responseTransformer) {
    const jsonStreamHeaders = new Headers(response.headers);
    jsonStreamHeaders.set('content-type', 'text/event-stream');
    jsonStreamHeaders.delete('content-encoding');
    jsonStreamHeaders.delete('content-length');

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: jsonStreamHeaders,
    });
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('content-encoding');
  responseHeaders.delete('content-length');

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export async function handleJSONToStreamResponse(
  response: Response,
  provider: string,
  responseTransformerFunction: Function,
  _strictOpenAiCompliance: boolean,
  _fn: endpointStrings,
  _hooksResult: any,
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const responseJSON: OpenAIChatCompleteResponse | OpenAICompleteResponse = await response
    .clone()
    .json();

  if (
    Object.prototype.toString.call(responseTransformerFunction) === '[object GeneratorFunction]'
  ) {
    const generator = responseTransformerFunction(responseJSON, provider);
    pipeToWriter(async () => {
      while (true) {
        const chunk = generator.next();
        if (chunk.done) break;
        await writer.write(encoder.encode(chunk.value));
      }
    }, writer);
  } else {
    const streamChunkArray = responseTransformerFunction(responseJSON, provider);
    pipeToWriter(async () => {
      for (const chunk of streamChunkArray) {
        await writer.write(encoder.encode(chunk));
      }
    }, writer);
  }

  return new Response(readable, {
    headers: new Headers({
      ...Object.fromEntries(response.headers),
      'content-type': CONTENT_TYPES.EVENT_STREAM,
    }),
    status: response.status,
    statusText: response.statusText,
  });
}
