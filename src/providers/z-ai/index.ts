import { Z_AI } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { ZAIImageGenerateConfig, ZAIImageGenerateResponseTransform } from './imageGenerate';

const ZAIConfig = defineOpenAICompatibleProvider({
  name: Z_AI,
  baseURL: 'https://api.z.ai/api/paas',
  endpoints: {
    chatComplete: { path: '/v4/chat/completions', defaultModel: 'glm-4.6' },
    imageGenerate: { path: '/v4/images/generations', defaultModel: null },
  },
});

export default {
  ...ZAIConfig,
  imageGenerate: ZAIImageGenerateConfig,
  responseTransforms: {
    ...ZAIConfig.responseTransforms,
    imageGenerate: ZAIImageGenerateResponseTransform,
  },
};
