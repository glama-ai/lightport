import { LEMONFOX_AI } from '../../globals';
import { responseTransformers } from '../open-ai-base';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { LemonfoxAIChatCompleteStreamChunkTransform } from './chatComplete';
import {
  LemonfoxAICreateTranscriptionResponseTransform,
  LemonfoxAIcreateTranscriptionConfig,
} from './createTranscription';
import {
  LemonfoxAIImageGenerateConfig,
  LemonfoxImageGenerateResponseTransform,
} from './imageGenerate';

const LemonfoxAIConfig = defineOpenAICompatibleProvider({
  name: LEMONFOX_AI,
  baseURL: 'https://api.lemonfox.ai',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: 'zephyr-chat',
      exclude: [
        'functions',
        'function_call',
        'n',
        'logit_bias',
        'user',
        'seed',
        'tools',
        'tool_choice',
        'response_format',
        'logprobs',
        'stream_options',
      ],
    },
    imageGenerate: { path: '/v1/images/generations', defaultModel: null },
  },
});

export default {
  ...LemonfoxAIConfig,
  imageGenerate: LemonfoxAIImageGenerateConfig,
  createTranscription: LemonfoxAIcreateTranscriptionConfig,
  api: {
    ...LemonfoxAIConfig.api,
    headers: ({ providerOptions, fn }: { providerOptions: any; fn: string; [key: string]: any }) => ({
      ...(providerOptions.apiKey && { Authorization: `Bearer ${providerOptions.apiKey}` }),
      ...(fn === 'createTranscription' && { 'content-type': 'multipart/form-data' }),
    }),
    getEndpoint: (args: { fn: string; [key: string]: any }) =>
      args.fn === 'createTranscription'
        ? '/v1/audio/transcriptions'
        : LemonfoxAIConfig.api.getEndpoint(args),
  },
  responseTransforms: {
    ...responseTransformers(LEMONFOX_AI, {
      chatComplete: (response, isError) => {
        if (isError || !('choices' in response)) return response;

        return {
          ...response,
          provider: LEMONFOX_AI,
          choices: response.choices.map((choice) => ({
            ...choice,
            message: {
              role: 'assistant',
              ...(choice.message as any),
            },
          })),
          usage: {
            prompt_tokens: response.usage?.prompt_tokens || 0,
            completion_tokens: response.usage?.completion_tokens || 0,
            total_tokens: response.usage?.total_tokens || 0,
          },
        };
      },
    }),
    'stream-chatComplete': LemonfoxAIChatCompleteStreamChunkTransform,
    imageGenerate: LemonfoxImageGenerateResponseTransform,
    createTranscription: LemonfoxAICreateTranscriptionResponseTransform,
  },
};
