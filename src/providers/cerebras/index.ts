import { CEREBRAS } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

export const cerebrasProviderAPIConfig = defineOpenAICompatibleProvider({
  name: CEREBRAS,
  baseURL: 'https://api.cerebras.ai',
  headers: () => ({ 'User-Agent': 'Lightport Gateway/1.0' }),
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: null,
    },
    // Chat and text completions expose different parameter sets. These are the
    // OpenAI text-completion parameters Cerebras leaves out.
    complete: {
      path: '/v1/completions',
      defaultModel: null,
      exclude: ['frequency_penalty', 'presence_penalty', 'logit_bias', 'best_of', 'n', 'suffix'],
      // Cerebras takes up to 20 here where OpenAI takes 5, and the shared
      // default is OpenAI's, so asking for more than 5 was quietly cut to 5.
      extra: { logprobs: { param: 'logprobs', min: 0, max: 20 } },
    },
  },
});
