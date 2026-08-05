import { CEREBRAS } from '../../globals';
import { chatCompleteParams, completeParams, responseTransformers } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import { cerebrasAPIConfig } from './api';

export const cerebrasProviderAPIConfig: ProviderConfigs = {
  chatComplete: chatCompleteParams([
    'frequency_penalty',
    'logit_bias',
    'logprobs',
    'presence_penalty',
    'parallel_tool_calls',
    'service_tier',
  ]),
  // Cerebras documents the parameters its completions endpoint takes, and these
  // are the ones it leaves out. `logprobs` is excluded from chat above but named
  // among them here, so the two lists differ on purpose.
  complete: completeParams(
    ['frequency_penalty', 'presence_penalty', 'logit_bias', 'best_of', 'n', 'suffix'],
    {},
    // Cerebras takes up to 20 here where OpenAI takes 5, and the shared default
    // is OpenAI's, so asking for more than 5 was quietly cut down to 5.
    { logprobs: { param: 'logprobs', min: 0, max: 20 } },
  ),
  api: cerebrasAPIConfig,
  responseTransforms: responseTransformers(CEREBRAS, {
    chatComplete: true,
    complete: true,
  }),
};
