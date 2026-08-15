import { CONTENT_TYPES } from '../globals';
import Providers from '../providers';
import { anthropicMessagesJsonToStreamGenerator } from '../providers/anthropic-base/utils/streamGenerator';
import { OpenAIModelResponseJSONToStreamGenerator } from '../providers/open-ai-base/createModelResponse';
import { OpenAIChatCompleteJSONToStreamResponseTransform } from '../providers/openai/chatComplete';
import { OpenAICompleteJSONToStreamResponseTransform } from '../providers/openai/complete';
import { endpointStrings } from '../providers/types';
import type { GatewayContext } from '../types/GatewayContext';
import { Options, Params } from '../types/requestBody';
import {
  handleAudioResponse,
  handleImageResponse,
  handleJSONToStreamResponse,
  handleNonStreamingMode,
  handleOctetStreamResponse,
  handleStreamingMode,
  handleTextResponse,
} from './streamHandler';

/**
 * Handles various types of responses based on the specified parameters
 * and returns a mapped response.
 */
export async function responseHandler(
  c: GatewayContext,
  response: Response,
  streamingMode: boolean,
  provider: string | Options,
  responseTransformer: string | undefined,
  requestURL: string,
  isCacheHit: boolean = false,
  gatewayRequest: Params,
  strictOpenAiCompliance: boolean,
  gatewayRequestUrl: string,
): Promise<{
  response: Response;
  responseJson: Record<string, any> | null;
  originalResponseJson?: Record<string, any> | null;
  timeToLastByte?: number | null;
}> {
  const startTime = Date.now();
  let responseTransformerFunction: Function | undefined;
  const responseContentType = response.headers?.get('content-type');
  const isSuccessStatusCode = [200, 246].includes(response.status);

  /*
    Whether the provider actually streamed, rather than whether the caller asked
    it to.

    `streamingMode` is read off the request before it is transformed, and several
    providers never receive the `stream` the caller wrote: image generation is
    the clear case — of the sixteen providers that generate images, all but two
    drop the parameter — but a chat provider that ignores it does the same thing.
    Read as SSE, a single JSON body yields no events at all, so the caller was
    answered 200 with an empty body and billed for a result the gateway threw
    away.

    A JSON body is the one content type that can never be an event stream, which
    makes it safe to say so here: no path that works today reaches this, because
    every path that reaches it returns nothing. Anything else — `text/event-
    stream`, or the binary frames Bedrock answers with — is left to the readers
    that understand it.
  */
  const upstreamStreamed = !responseContentType?.startsWith(CONTENT_TYPES.APPLICATION_JSON);
  // A cache hit is JSON by nature and is turned into a stream below on purpose,
  // so it is exempt from the check rather than caught by it.
  const isStreamingResponse = streamingMode && (isCacheHit || upstreamStreamed);

  if (typeof provider == 'object') {
    provider = provider.provider || '';
  }

  const providerConfig = Providers[provider];
  let providerTransformers = Providers[provider]?.responseTransforms;

  if (providerConfig?.getConfig) {
    providerTransformers = providerConfig.getConfig({
      params: gatewayRequest,
      providerOptions: {} as Options,
    }).responseTransforms;
  }

  if (responseTransformer && isStreamingResponse && isSuccessStatusCode) {
    responseTransformerFunction = providerTransformers?.[`stream-${responseTransformer}`];
  } else if (responseTransformer) {
    responseTransformerFunction = providerTransformers?.[responseTransformer];
  }

  // JSON to text/event-stream conversion for cache hits
  if (responseTransformer && streamingMode && isCacheHit) {
    switch (responseTransformer) {
      case 'chatComplete':
        responseTransformerFunction = OpenAIChatCompleteJSONToStreamResponseTransform;
        break;
      case 'createModelResponse':
        responseTransformerFunction = OpenAIModelResponseJSONToStreamGenerator;
        break;
      case 'messages':
        responseTransformerFunction = anthropicMessagesJsonToStreamGenerator;
        break;
      default:
        responseTransformerFunction = OpenAICompleteJSONToStreamResponseTransform;
        break;
    }
  } else if (responseTransformer && !streamingMode && isCacheHit) {
    responseTransformerFunction = undefined;
  }

  if (isStreamingResponse && isSuccessStatusCode) {
    if (isCacheHit && responseTransformerFunction) {
      const streamingResponse = await handleJSONToStreamResponse(
        response,
        provider,
        responseTransformerFunction,
        strictOpenAiCompliance,
        responseTransformer as endpointStrings,
        null,
      );
      return { response: streamingResponse, responseJson: null };
    }
    return {
      response: handleStreamingMode(
        c,
        response,
        provider,
        responseTransformerFunction,
        requestURL,
        strictOpenAiCompliance,
        gatewayRequest,
        responseTransformer as endpointStrings,
        null,
      ),
      responseJson: null,
    };
  }

  if (responseContentType?.startsWith(CONTENT_TYPES.GENERIC_AUDIO_PATTERN)) {
    return { response: handleAudioResponse(response), responseJson: null };
  }

  if (
    responseContentType === CONTENT_TYPES.APPLICATION_OCTET_STREAM ||
    responseContentType === CONTENT_TYPES.BINARY_OCTET_STREAM
  ) {
    return {
      response: handleOctetStreamResponse(response),
      responseJson: null,
    };
  }

  if (responseContentType?.startsWith(CONTENT_TYPES.GENERIC_IMAGE_PATTERN)) {
    return { response: handleImageResponse(response), responseJson: null };
  }

  if (
    responseContentType?.startsWith(CONTENT_TYPES.PLAIN_TEXT) ||
    responseContentType?.startsWith(CONTENT_TYPES.HTML) ||
    responseContentType?.startsWith(CONTENT_TYPES.XML) ||
    responseContentType?.toLowerCase()?.includes('xml')
  ) {
    const textResponse = await handleTextResponse(response, responseTransformerFunction);
    return { response: textResponse, responseJson: null };
  }

  if (!responseContentType && response.status === 204) {
    return {
      response: new Response(response.body, response),
      responseJson: null,
    };
  }

  if (!responseContentType) {
    return {
      response: new Response(response.body, response),
      responseJson: null,
    };
  }

  const nonStreamingResponse = await handleNonStreamingMode(
    response,
    responseTransformerFunction,
    strictOpenAiCompliance,
    gatewayRequestUrl,
    gatewayRequest,
    false,
  );

  return {
    response: nonStreamingResponse.response,
    responseJson: nonStreamingResponse.json,
    originalResponseJson: nonStreamingResponse.originalResponseBodyJson,
    timeToLastByte: nonStreamingResponse.timeToLastByte
      ? nonStreamingResponse.timeToLastByte - startTime
      : null,
  };
}
