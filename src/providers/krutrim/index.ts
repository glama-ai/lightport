import { KRUTRIM } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { KrutrimChatCompleteResponseTransform } from './chatComplete';

const KrutrimConfig = defineOpenAICompatibleProvider({
  name: KRUTRIM,
  baseURL: 'https://cloud.olakrutrim.com',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: 'Llama-3.3-70B-Instruct' },
  },
});

export default {
  ...KrutrimConfig,
  responseTransforms: { chatComplete: KrutrimChatCompleteResponseTransform },
};
