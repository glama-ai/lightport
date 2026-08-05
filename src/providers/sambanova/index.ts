import { SAMBANOVA } from '../../globals';
import { chatCompleteParams, completeParams, responseTransformers } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import SambaNovaAPIConfig from './api';
import {
  SambaNovaChatCompleteStreamChunkTransform,
  SambaNovaCompleteStreamChunkTransform,
} from './chatComplete';

const SambaNovaConfig: ProviderConfigs = {
  chatComplete: chatCompleteParams(
    [
      'functions',
      'function_call',
      'presence_penalty',
      'frequency_penalty',
      'logit_bias',
      'user',
      'seed',
      'tools',
      'tool_choice',
      'response_format',
      'logprobs',
    ],
    {
      model: 'Meta-Llama-3.1-8B-Instruct',
    },
  ),
  // Taken from what SambaNova publishes for completions, which is not what it
  // publishes for chat: `logprobs` it names as not yet supported there, while
  // chat has it, and `logit_bias` and `seed` are the other way round. No model
  // is defaulted, the one chat names having since been withdrawn — a request
  // that does not choose is better told so than sent to a model that is gone.
  complete: completeParams(['presence_penalty', 'frequency_penalty', 'user', 'logprobs']),
  api: SambaNovaAPIConfig,
  responseTransforms: {
    ...responseTransformers(SAMBANOVA, {
      complete: true,
      chatComplete: (response, isError) => {
        if (isError || !('choices' in response)) return response;

        return {
          ...response,
          provider: SAMBANOVA,
          choices: response.choices.map((choice) => ({
            ...choice,
            message: {
              role: 'assistant',
              ...(choice.message as any),
            },
          })),
          usage: {
            prompt_tokens: response.usage?.prompt_tokens || 0,
            completion_tokens: response.usage?.completion_tokens || 0,
            total_tokens: response.usage?.total_tokens || 0,
          },
        };
      },
    }),
    'stream-chatComplete': SambaNovaChatCompleteStreamChunkTransform,
    'stream-complete': SambaNovaCompleteStreamChunkTransform,
  },
};

export default SambaNovaConfig;
