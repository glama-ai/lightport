import { DASHSCOPE } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

export const DashScopeConfig = defineOpenAICompatibleProvider({
  name: DASHSCOPE,
  baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: 'qwen-turbo',
      extra: {
        top_k: { param: 'top_k' },
        repetition_penalty: { param: 'repetition_penalty' },
        stop: { param: 'stop' },
        enable_search: { param: 'enable_search' },
        enable_thinking: { param: 'enable_thinking' },
        thinking_budget: { param: 'thinking_budget' },
      },
    },
    embed: { path: '/v1/embeddings', defaultModel: 'text-embedding-v1' },
  },
});
