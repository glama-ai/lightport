import { AI21 } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

/**
 * AI21, whose Jamba models are served from an OpenAI-shaped endpoint.
 *
 * Every request to AI21 failed. Chat went to `/{model}/chat` with Jurassic-2's
 * parameter names and was read back expecting Jurassic-2's `outputs`; that path
 * now answers 404, as do the `/{model}/complete` and `/embed` this provider also
 * claimed. Jamba is served at `/v1/chat/completions` alone, which takes and
 * returns OpenAI's shape, so that is all this declares.
 *
 * Only the parameters AI21 documents for it are sent. `documents` is AI21's own,
 * the grounding passages the model answers from, and `max_tokens` is the only
 * limit it names — so the newer OpenAI name is sent under it.
 */
const AI21Config = defineOpenAICompatibleProvider({
  name: AI21,
  baseURL: 'https://api.ai21.com/studio',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: null,
      exclude: [
        'audio',
        'frequency_penalty',
        'function_call',
        'functions',
        'logit_bias',
        'logprobs',
        'metadata',
        'modalities',
        'parallel_tool_calls',
        'prediction',
        'presence_penalty',
        'prompt_cache_key',
        'prompt_cache_retention',
        'reasoning_effort',
        'safety_identifier',
        'seed',
        'service_tier',
        'store',
        'stream_options',
        'tool_choice',
        'top_logprobs',
        'user',
        'verbosity',
        'web_search_options',
      ],
      extra: {
        documents: { param: 'documents' },
        max_completion_tokens: { param: 'max_tokens', min: 0 },
      },
    },
  },
});

export default AI21Config;
