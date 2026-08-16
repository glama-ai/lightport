import { SAMBANOVA } from '../../globals';
import { responseTransformers } from '../open-ai-base';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';
import {
  SambaNovaChatCompleteStreamChunkTransform,
  SambaNovaCompleteStreamChunkTransform,
} from './chatComplete';

const SambaNovaConfig = defineOpenAICompatibleProvider({
  name: SAMBANOVA,
  baseURL: 'https://api.sambanova.ai',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: 'Meta-Llama-3.1-8B-Instruct',
      exclude: [
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
    },
    // Taken from what SambaNova publishes for completions, which is not what it
    // publishes for chat: `logprobs` it names as not yet supported there, while
    // chat has it, and `logit_bias` and `seed` are the other way round. No model
    // is defaulted, the one chat names having since been withdrawn — a request
    // that does not choose is better told so than sent to a model that is gone.
    complete: {
      path: '/v1/completions',
      defaultModel: null,
      exclude: ['presence_penalty', 'frequency_penalty', 'user', 'logprobs'],
    },
  },
});

export default {
  ...SambaNovaConfig,
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
