import { FEATHERLESS_AI } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

export const FeatherlessAIConfig = defineOpenAICompatibleProvider({
  name: FEATHERLESS_AI,
  baseURL: 'https://api.featherless.ai',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: 'mistralai/Magistral-Small-2506',
    },
    complete: { path: '/v1/completions', defaultModel: 'mistralai/Magistral-Small-2506' },
  },
});
