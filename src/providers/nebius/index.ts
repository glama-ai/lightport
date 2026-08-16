import { NEBIUS } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

const NebiusConfig = defineOpenAICompatibleProvider({
  name: NEBIUS,
  baseURL: 'https://api.studio.nebius.ai',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: 'Qwen/Qwen2.5-72B-Instruct-fast' },
    complete: { path: '/v1/completions', defaultModel: 'Qwen/Qwen2.5-72B-Instruct-fast' },
    embed: { path: '/v1/embeddings', defaultModel: 'BAAI/bge-en-icl' },
  },
});

export default NebiusConfig;
