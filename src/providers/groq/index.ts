import { GROQ } from '../../globals';
import { createModelResponseParams, createSpeechParams, responseTransformers } from '../open-ai-base';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { GroqChatCompleteStreamChunkTransform } from './chatComplete';

const GroqConfig = defineOpenAICompatibleProvider({
  name: GROQ,
  baseURL: 'https://api.groq.com/openai',
  nativeResponses: true,
  headers: () => ({}),
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: null,
      exclude: ['logprobs', 'logits_bias', 'top_logprobs'],
      extra: {
        service_tier: { param: 'service_tier', required: false },
        reasoning_effort: { param: 'reasoning_effort', required: false },
      },
    },
  },
});

export default {
  ...GroqConfig,
  createModelResponse: createModelResponseParams([]),
  createTranscription: {},
  createTranslation: {},
  createSpeech: createSpeechParams([]),
  api: {
    ...GroqConfig.api,
    headers: ({ providerOptions, fn }: { providerOptions: any; fn: string; [key: string]: any }) => ({
      ...(providerOptions.apiKey && { Authorization: `Bearer ${providerOptions.apiKey}` }),
      ...(['createTranscription', 'createTranslation'].includes(fn) && {
        'Content-Type': 'multipart/form-data',
      }),
    }),
    getEndpoint: (args: { fn: string; [key: string]: any }) => {
      switch (args.fn) {
        case 'createTranscription':
          return '/v1/audio/transcriptions';
        case 'createTranslation':
          return '/v1/audio/translations';
        case 'createSpeech':
          return '/v1/audio/speech';
        case 'createModelResponse':
          return '/v1/responses';
        default:
          return GroqConfig.api.getEndpoint(args);
      }
    },
  },
  responseTransforms: {
    ...responseTransformers(GROQ, { chatComplete: true, createSpeech: true }),
    'stream-chatComplete': GroqChatCompleteStreamChunkTransform,
  },
};
