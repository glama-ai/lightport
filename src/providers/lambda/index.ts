import { LAMBDA } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

export const LambdaProviderConfig = defineOpenAICompatibleProvider({
  name: LAMBDA,
  baseURL: 'https://api.lambdalabs.com',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: 'Liquid-AI-40B' },
    complete: { path: '/v1/completions', defaultModel: 'Liquid-AI-40B' },
  },
});
