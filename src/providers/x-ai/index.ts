import { X_AI } from '../../globals';
import { createModelResponseParams, responseTransformers } from '../open-ai-base';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { ErrorResponse } from '../types';

interface XAIErrorResponse {
  error?: Record<string, unknown> | string;
  code?: string;
}

// xAI reports a failure as a bare string under `error`, which the shared reader
// would report whole. Named here so the message reaches the caller as xAI wrote
// it.
const xAIResponseTransform = <T>(response: T) => {
  const _response = response as XAIErrorResponse;

  if ('error' in _response) {
    return {
      error: {
        message: _response.error as string,
        code: _response.code ?? null,
        param: null,
        type: null,
      },
      provider: X_AI,
    } as ErrorResponse;
  }

  return response;
};

const XAIConfig = defineOpenAICompatibleProvider({
  name: X_AI,
  baseURL: 'https://api.x.ai',
  nativeResponses: true,
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: 'grok-beta' },
    complete: { path: '/v1/completions', defaultModel: 'grok-beta' },
    embed: { path: '/v1/embeddings', defaultModel: 'v1' },
  },
});

export default {
  ...XAIConfig,
  createModelResponse: createModelResponseParams([]),
  realtime: {},
  api: {
    ...XAIConfig.api,
    getEndpoint: (args: { fn: string; [key: string]: any }) => {
      switch (args.fn) {
        case 'createModelResponse':
          return '/v1/responses';
        // xAI's realtime API uses a fixed endpoint with a default model.
        // See: https://docs.x.ai/docs/guides/voice/agent
        case 'realtime':
          return '/v1/realtime';
        default:
          return XAIConfig.api.getEndpoint(args);
      }
    },
  },
  responseTransforms: {
    // Named here rather than left to the declaration: these run inside the
    // shared pipeline, which reads the body first and stamps the provider
    // after.
    ...responseTransformers(X_AI, {
      chatComplete: xAIResponseTransform,
      complete: xAIResponseTransform,
      embed: xAIResponseTransform,
    }),
    realtime: {},
  },
};
