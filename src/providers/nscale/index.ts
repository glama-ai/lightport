import { NSCALE } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { NscaleImageGenerateConfig, NscaleImageGenerateResponseTransform } from './imageGenerate';

const NscaleConfig = defineOpenAICompatibleProvider({
  name: NSCALE,
  baseURL: 'https://inference.api.nscale.com',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: null,
      exclude: [
        'functions',
        'function_call',
        'user',
        'seed',
        'tools',
        'tool_choice',
        'stream_options',
      ],
    },
    // `user` alone: nScale publishes `seed` for completions, which chat
    // excludes, so the two lists are not the same list.
    complete: { path: '/v1/completions', defaultModel: null, exclude: ['user'] },
    imageGenerate: { path: '/v1/images/generations' },
  },
});

export default {
  ...NscaleConfig,
  imageGenerate: NscaleImageGenerateConfig,
  responseTransforms: {
    ...NscaleConfig.responseTransforms,
    imageGenerate: NscaleImageGenerateResponseTransform,
  },
};
