import { AIBADGR } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import { AIBadgrChatCompleteStreamChunkTransform } from './chatComplete';

const AIBadgrConfig = defineOpenAICompatibleProvider({
  name: AIBADGR,
  baseURL: 'https://aibadgr.com/api',
  endpoints: {
    chatComplete: { path: '/v1/chat/completions', defaultModel: null },
  },
});

export default {
  ...AIBadgrConfig,
  responseTransforms: {
    ...AIBadgrConfig.responseTransforms,
    'stream-chatComplete': AIBadgrChatCompleteStreamChunkTransform,
  },
};
