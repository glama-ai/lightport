import { AIBADGR } from '../../globals';
import { chatCompleteParams, responseTransformers } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import AIBadgrAPIConfig from './api';
import { AIBadgrChatCompleteStreamChunkTransform } from './chatComplete';

const AIBadgrConfig: ProviderConfigs = {
  api: AIBadgrAPIConfig,
  chatComplete: chatCompleteParams([]),
  responseTransforms: {
    ...responseTransformers(AIBADGR, {
      chatComplete: true,
    }),
    'stream-chatComplete': AIBadgrChatCompleteStreamChunkTransform,
  },
};

export default AIBadgrConfig;
