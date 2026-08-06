import { SCX_AI } from '../../globals';
import { chatCompleteParams, responseTransformers } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import SCXAIAPIConfig from './api';

// SCX.ai exposes /v1/completions, but it is aliased to chat: the response is a
// `chat.completion` carrying `message` rather than a `text_completion` carrying
// `text`. Text completions are left out so the shared transformer is not handed
// a shape it cannot read.
const SCXAIConfig: ProviderConfigs = {
  chatComplete: chatCompleteParams(['logprobs', 'top_logprobs', 'n', 'logit_bias']),
  api: SCXAIAPIConfig,
  responseTransforms: responseTransformers(SCX_AI, {
    chatComplete: true,
  }),
};

export default SCXAIConfig;
