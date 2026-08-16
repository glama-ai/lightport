import { OVHCLOUD } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { OVHcloudChatCompleteStreamChunkTransform } from './chatComplete';

const OVHcloudConfig = defineOpenAICompatibleProvider({
  name: OVHCLOUD,
  baseURL: 'https://oai.endpoints.kepler.ai.cloud.ovh.net',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: 'axon' },
  },
});

export default {
  ...OVHcloudConfig,
  responseTransforms: {
    ...OVHcloudConfig.responseTransforms,
    'stream-chatComplete': OVHcloudChatCompleteStreamChunkTransform,
  },
};
