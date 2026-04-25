import { GROQ } from '../../globals';
import {
  chatCompleteParams,
  responseTransformers,
  createSpeechParams,
  createModelResponseParams,
} from '../open-ai-base';
import { ProviderConfigs } from '../types';
import GroqAPIConfig from './api';
import { GroqChatCompleteStreamChunkTransform } from './chatComplete';

const GroqConfig: ProviderConfigs = {
  chatComplete: chatCompleteParams(['logprobs', 'logits_bias', 'top_logprobs'], undefined, {
    service_tier: { param: 'service_tier', required: false },
    reasoning_effort: { param: 'reasoning_effort', required: false },
  }),
  createModelResponse: createModelResponseParams([]),
  api: GroqAPIConfig,
  createTranscription: {},
  createTranslation: {},
  createSpeech: createSpeechParams([]),
  responseTransforms: {
    ...responseTransformers(GROQ, {
      chatComplete: true,
      createSpeech: true,
    }),
    'stream-chatComplete': GroqChatCompleteStreamChunkTransform,
  },
};

export default GroqConfig;
