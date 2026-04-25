import { NSCALE } from '../../globals';
import { chatCompleteParams, responseTransformers } from '../open-ai-base';
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
  imageGenerate: NscaleImageGenerateConfig,
  api: NscaleAPIConfig,
  responseTransforms: {
    ...responseTransformers(NSCALE, { chatComplete: true }),
    imageGenerate: NscaleImageGenerateResponseTransform,
  },
};

export default NscaleConfig;
