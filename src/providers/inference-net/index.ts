import { INFERENCENET } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

export const InferenceNetProviderConfigs = defineOpenAICompatibleProvider({
  name: INFERENCENET,
  baseURL: 'https://api.inference.net',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: 'llama3' },
  },
});
