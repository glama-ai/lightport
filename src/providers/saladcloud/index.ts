import { SALADCLOUD } from '../../globals';
import { defineOpenAICompatibleProvider } from '../open-ai-base/define';

/**
 * SaladCloud, whose whole shape the shared base now covers.
 *
 * It reports thinking as `reasoning_text` and failures as RFC 7807 problem
 * details. Neither is SaladCloud's own invention — the first is a vLLM
 * convention, the second a standard — so both are read where every provider
 * benefits rather than here.
 */
const SaladCloudConfig = defineOpenAICompatibleProvider({
  name: SALADCLOUD,
  baseURL: 'https://ai.salad.cloud',
  endpoints: {
    chatComplete: {
      path: '/v1/chat/completions',
      defaultModel: 'qwen3.6-35b-a3b',
      exclude: [
        'audio',
        'logit_bias',
        'logprobs',
        'metadata',
        'modalities',
        'parallel_tool_calls',
        'prediction',
        'prompt_cache_key',
        'prompt_cache_retention',
        'safety_identifier',
        'service_tier',
        'store',
        'top_logprobs',
        'verbosity',
        'web_search_options',
      ],
      extra: {
        top_k: { param: 'top_k' },
        chat_template_kwargs: { param: 'chat_template_kwargs' },
      },
    },
  },
});

export default SaladCloudConfig;
