import { NSCALE } from '../../globals';
import { chatCompleteParams, completeParams, responseTransformers } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import NscaleAPIConfig from './api';
import { NscaleImageGenerateConfig, NscaleImageGenerateResponseTransform } from './imageGenerate';

const NscaleConfig: ProviderConfigs = {
  chatComplete: chatCompleteParams([
    'functions',
    'function_call',
    'user',
    'seed',
    'tools',
    'tool_choice',
    'stream_options',
  ]),
  // `user` alone: nScale publishes `seed` for completions, which chat excludes,
  // so the two lists are not the same list.
  complete: completeParams(['user']),
  imageGenerate: NscaleImageGenerateConfig,
  api: NscaleAPIConfig,
  responseTransforms: {
    ...responseTransformers(NSCALE, { chatComplete: true, complete: true }),
    imageGenerate: NscaleImageGenerateResponseTransform,
  },
};

export default NscaleConfig;
