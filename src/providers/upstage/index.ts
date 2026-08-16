import { UPSTAGE } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

export const UpstageConfig = defineOpenAICompatibleProvider({
  name: UPSTAGE,
  baseURL: 'https://api.upstage.ai',
  endpoints: {
    chatComplete: { path: '/v1/solar/chat/completions', defaultModel: 'solar-pro' },
    embed: { path: '/v1/solar/embeddings', defaultModel: 'solar-embedding-1-large-query' },
  },
});
