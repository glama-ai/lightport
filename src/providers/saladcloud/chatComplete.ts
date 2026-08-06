import { SALADCLOUD } from '../../globals';
import { OpenAIErrorResponseTransform } from '../openai/utils';
import { ChatCompletionResponse, ErrorResponse, ProviderConfig } from '../types';
import {
  generateErrorResponse,
  generateInvalidProviderResponseError,
  transformReasoning,
} from '../utils';

export const SaladCloudChatCompleteExcludedParams = [
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
];

export const SaladCloudChatCompleteDefaults = {
  model: 'qwen3.6-35b-a3b',
};

export const SaladCloudChatCompleteExtraParams: ProviderConfig = {
  top_k: {
    param: 'top_k',
  },
  chat_template_kwargs: {
    param: 'chat_template_kwargs',
  },
};

interface SaladCloudProblemDetails {
  detail?: string;
  status?: number;
  title?: string;
  type?: string;
}

export const SaladCloudChatCompleteResponseTransform = (
  response: ChatCompletionResponse | ErrorResponse | SaladCloudProblemDetails,
  responseStatus: number,
  _responseHeaders: Headers,
  strictOpenAiCompliance: boolean,
): ChatCompletionResponse | ErrorResponse => {
  if (responseStatus !== 200) {
    if ('error' in response) {
      return OpenAIErrorResponseTransform(response, SALADCLOUD);
    }

    const problem = response as SaladCloudProblemDetails;
    return generateErrorResponse(
      {
        message: problem.detail ?? problem.title ?? `HTTP ${responseStatus}`,
        type: problem.type ?? null,
        param: null,
        code: problem.status === undefined ? null : String(problem.status),
      },
      SALADCLOUD,
    );
  }

  const answered = response as ChatCompletionResponse;
  if (!Array.isArray(answered.choices)) {
    return generateInvalidProviderResponseError(response as Record<string, unknown>, SALADCLOUD);
  }

  return {
    ...answered,
    provider: SALADCLOUD,
    choices: answered.choices.map((choice) => {
      const message = choice.message as typeof choice.message & {
        reasoning?: string;
        reasoning_content?: string;
        reasoning_text?: string;
      };
      const reasoning = message.reasoning_content || message.reasoning || message.reasoning_text;

      return {
        ...choice,
        message: {
          ...message,
          ...transformReasoning(
            { ...message, reasoning_content: reasoning },
            strictOpenAiCompliance,
          ),
        },
      };
    }),
  };
};
