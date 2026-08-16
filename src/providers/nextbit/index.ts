import { NEXTBIT } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

export const NextBitConfig = defineOpenAICompatibleProvider({
  name: NEXTBIT,
  baseURL: 'https://api.nextbit256.com',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: 'microsoft:phi-4' },
    complete: { path: '/v1/completions', defaultModel: 'microsoft:phi-4' },
  },
});
